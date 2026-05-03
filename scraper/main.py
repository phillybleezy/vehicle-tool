"""
Car listing scraper — AutoTempest + Craigslist Phoenix.
Usage:
  python scraper/main.py            # scrape and write to Cloudflare KV
  python scraper/main.py --dry-run  # print results, no KV write
"""

import argparse
import hashlib
import os
import random
import re
import sys
import time
from datetime import datetime, timezone, timedelta

import requests
from bs4 import BeautifulSoup
from fake_useragent import UserAgent

from scraper.config import (
    YEAR_MIN, YEAR_MAX, MAKES, MAX_MILEAGE, MAX_PRICE,
    ZIP_CODE, RADIUS_MILES, PRUNE_AFTER_DAYS,
)

WORKER_URL = os.environ.get("WORKER_URL") or "https://vehicle-tool-api.wrathofkaren.workers.dev"
SCRAPER_TOKEN = os.environ.get("SCRAPER_TOKEN", "")

_ua = UserAgent()

def _headers():
    return {
        "User-Agent": _ua.random,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    }

def _sleep():
    time.sleep(random.uniform(1.0, 2.5))

def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def _listing_id(url):
    return hashlib.sha256(url.encode()).hexdigest()[:8]

def _parse_price(text):
    digits = re.sub(r"[^\d]", "", text or "")
    return int(digits) if digits else 0

def _parse_mileage(text):
    m = re.search(r"([\d,]+)\s*(?:mi|mile|miles|k\s*mi)", (text or "").lower())
    if m:
        return int(m.group(1).replace(",", ""))
    return 0

def _parse_year(text):
    m = re.search(r"\b(20\d{2})\b", text or "")
    return int(m.group(1)) if m else 0

def _parse_make(title, makes=MAKES):
    lower = title.lower()
    for make in makes:
        if make in lower:
            return make.capitalize()
    return ""

def _parse_model_trim(title, make):
    # Strip leading year and make, remainder is model+trim
    pattern = rf"\b20\d\d\b\s*{re.escape(make)}\s*"
    rest = re.sub(pattern, "", title, flags=re.IGNORECASE).strip()
    parts = rest.split(None, 1)
    model = parts[0] if parts else ""
    trim = parts[1] if len(parts) > 1 else ""
    return model, trim

# ---------------------------------------------------------------------------
# AutoTempest scraper
# ---------------------------------------------------------------------------

def scrape_autotempest(make):
    url = "https://www.autotempest.com/results"
    params = {
        "make": make,
        "zip": ZIP_CODE,
        "radius": RADIUS_MILES,
        "minyear": YEAR_MIN,
        "maxyear": YEAR_MAX,
        "maxprice": MAX_PRICE,
        "maxmiles": MAX_MILEAGE,
    }
    try:
        resp = requests.get(url, params=params, headers=_headers(), timeout=20)
        resp.raise_for_status()
    except Exception as exc:
        print(f"[AutoTempest/{make}] fetch error: {exc}", file=sys.stderr)
        return []

    soup = BeautifulSoup(resp.text, "lxml")
    listings = []

    # AutoTempest wraps each result in <li class="srp-list-item"> or similar
    items = soup.select("li.srp-list-item, li[class*='listing'], div[class*='listing-item']")
    if not items:
        # Fallback: any <li> with a price-looking element
        items = soup.find_all("li", class_=re.compile(r"result|listing|item", re.I))

    for item in items:
        try:
            link_tag = item.find("a", href=True)
            if not link_tag:
                continue
            listing_url = link_tag["href"]
            if not listing_url.startswith("http"):
                listing_url = "https://www.autotempest.com" + listing_url

            title_el = item.select_one("[class*='title'], [class*='heading'], h2, h3")
            title = title_el.get_text(strip=True) if title_el else link_tag.get_text(strip=True)

            price_el = item.select_one("[class*='price']")
            price = _parse_price(price_el.get_text() if price_el else "")

            mileage_el = item.select_one("[class*='mileage'], [class*='miles']")
            mileage = _parse_mileage(mileage_el.get_text() if mileage_el else title)

            location_el = item.select_one("[class*='location'], [class*='city']")
            location = location_el.get_text(strip=True) if location_el else ""

            source_el = item.select_one("[class*='source'], [class*='site'], [class*='partner']")
            source_label = source_el.get_text(strip=True) if source_el else ""
            source_type = "private" if "craigslist" in source_label.lower() else "dealer"

            year = _parse_year(title)
            item_make = _parse_make(title)
            model, trim = _parse_model_trim(title, item_make or make.capitalize())

            listings.append({
                "id": _listing_id(listing_url),
                "url": listing_url,
                "title": title,
                "year": year,
                "make": item_make or make.capitalize(),
                "model": model,
                "trim": trim,
                "price": price,
                "mileage": mileage,
                "distance_miles": 0,
                "source": "AutoTempest",
                "source_type": source_type,
                "location": location,
                "description": "",
                "vin": "",
                "image_url": "",
                "first_seen": "",
                "last_seen": "",
                "days_on_market": 0,
            })
        except Exception as exc:
            print(f"[AutoTempest/{make}] parse error on item: {exc}", file=sys.stderr)

    return listings

# ---------------------------------------------------------------------------
# Craigslist Phoenix scraper
# ---------------------------------------------------------------------------

def scrape_craigslist(make):
    url = "https://phoenix.craigslist.org/search/cto"
    params = {
        "auto_make_model": make,
        "min_auto_year": YEAR_MIN,
        "max_auto_year": YEAR_MAX,
        "max_auto_miles": MAX_MILEAGE,
        "max_price": MAX_PRICE,
        "postal": ZIP_CODE,
        "search_distance": RADIUS_MILES,
        "auto_title_status": 1,  # clean title only
    }
    try:
        resp = requests.get(url, params=params, headers=_headers(), timeout=20)
        resp.raise_for_status()
    except Exception as exc:
        print(f"[Craigslist/{make}] fetch error: {exc}", file=sys.stderr)
        return []

    soup = BeautifulSoup(resp.text, "lxml")
    listings = []

    # Craigslist new layout: <li class="cl-search-result"> or old: <li class="result-row">
    items = soup.select("li.cl-search-result, li.result-row")

    for item in items:
        try:
            link_tag = item.find("a", href=True)
            if not link_tag:
                continue
            listing_url = link_tag["href"]
            if not listing_url.startswith("http"):
                listing_url = "https://phoenix.craigslist.org" + listing_url

            # New layout: a.cl-app-anchor or title span
            title_el = item.select_one(".cl-listing-title, .result-title, a[class*='title']")
            title = title_el.get_text(strip=True) if title_el else link_tag.get_text(strip=True)

            price_el = item.select_one(".price, [class*='price']")
            price = _parse_price(price_el.get_text() if price_el else "")

            mileage = _parse_mileage(title)

            location_el = item.select_one(".result-hood, [class*='location'], [class*='hood']")
            location = location_el.get_text(strip=True).strip("()") if location_el else "Phoenix, AZ"

            year = _parse_year(title)
            item_make = _parse_make(title)
            model, trim = _parse_model_trim(title, item_make or make.capitalize())

            listings.append({
                "id": _listing_id(listing_url),
                "url": listing_url,
                "title": title,
                "year": year,
                "make": item_make or make.capitalize(),
                "model": model,
                "trim": trim,
                "price": price,
                "mileage": mileage,
                "distance_miles": 0,
                "source": "Craigslist",
                "source_type": "private",
                "location": location,
                "description": "",
                "vin": "",
                "image_url": "",
                "first_seen": "",
                "last_seen": "",
                "days_on_market": 0,
            })
        except Exception as exc:
            print(f"[Craigslist/{make}] parse error on item: {exc}", file=sys.stderr)

    return listings

# ---------------------------------------------------------------------------
# KV read/write
# ---------------------------------------------------------------------------

def _auth_headers():
    return {"Authorization": f"Bearer {SCRAPER_TOKEN}", "Content-Type": "application/json"}

def fetch_existing_listings():
    try:
        resp = requests.get(
            f"{WORKER_URL}/api/listings",
            headers=_auth_headers(),
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("listings", [])
    except Exception as exc:
        print(f"[KV] Could not fetch existing listings (starting fresh): {exc}", file=sys.stderr)
        return []

def write_listings(listings):
    import json
    payload = {"listings": listings, "last_updated": _now_iso()}
    try:
        resp = requests.post(
            f"{WORKER_URL}/api/listings",
            headers=_auth_headers(),
            data=json.dumps(payload),
            timeout=20,
        )
        resp.raise_for_status()
        print(f"[KV] Wrote {len(listings)} listings.")
    except Exception as exc:
        print(f"[KV] Write failed: {exc}", file=sys.stderr)
        sys.exit(1)

# ---------------------------------------------------------------------------
# Merge + deduplicate
# ---------------------------------------------------------------------------

def merge(existing, fresh):
    now = _now_iso()
    existing_map = {l["id"]: l for l in existing}
    cutoff = datetime.now(timezone.utc) - timedelta(days=PRUNE_AFTER_DAYS)

    for listing in fresh:
        lid = listing["id"]
        if lid in existing_map:
            # Update timestamps only
            existing_map[lid]["last_seen"] = now
            fs = existing_map[lid].get("first_seen") or now
            try:
                first_dt = datetime.strptime(fs, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
                existing_map[lid]["days_on_market"] = (datetime.now(timezone.utc) - first_dt).days
            except ValueError:
                pass
        else:
            listing["first_seen"] = now
            listing["last_seen"] = now
            listing["days_on_market"] = 0
            existing_map[lid] = listing

    # Prune stale listings
    result = []
    for l in existing_map.values():
        ls = l.get("last_seen") or l.get("first_seen", "")
        try:
            last_dt = datetime.strptime(ls, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            if last_dt >= cutoff:
                result.append(l)
        except ValueError:
            result.append(l)  # keep if unparseable

    result.sort(key=lambda x: x.get("price") or 999_999)
    return result

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Print results, do not write to KV")
    args = parser.parse_args()

    if not args.dry_run and not SCRAPER_TOKEN:
        print("[ERROR] SCRAPER_TOKEN env var not set.", file=sys.stderr)
        sys.exit(1)

    fresh = []

    for make in MAKES:
        print(f"[AutoTempest] Scraping {make}...")
        results = scrape_autotempest(make)
        print(f"[AutoTempest] {make}: {len(results)} listings")
        fresh.extend(results)
        _sleep()

    for make in MAKES:
        print(f"[Craigslist] Scraping {make}...")
        results = scrape_craigslist(make)
        print(f"[Craigslist] {make}: {len(results)} listings")
        fresh.extend(results)
        _sleep()

    if not fresh:
        print("[WARNING] Zero listings scraped from all sources.", file=sys.stderr)

    if args.dry_run:
        print(f"\n{'TITLE':<45} {'PRICE':>8} {'MILES':>8}  {'SOURCE':<14} TYPE")
        print("-" * 90)
        for l in sorted(fresh, key=lambda x: x.get("price") or 999_999):
            print(
                f"{l['title'][:44]:<45} "
                f"${l['price']:>7,} "
                f"{l['mileage']:>8,}  "
                f"{l['source']:<14} "
                f"{l['source_type']}"
            )
        print(f"\n{len(fresh)} listings found.")
        return

    existing = fetch_existing_listings()
    merged = merge(existing, fresh)
    write_listings(merged)

if __name__ == "__main__":
    main()
