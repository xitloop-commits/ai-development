
import env_loader  # noqa: F401 — load .env from project root

import json
import os
import time
import math
from datetime import datetime, timedelta
import requests

# --- Configuration ---
INSTRUMENTS = [
    "NIFTY_50",
    "BANKNIFTY",
    "CRUDEOIL",
    "NATURALGAS"
]

DATA_DIR = os.path.dirname(__file__)

# Dashboard URL for active instruments polling
DASHBOARD_URL = os.environ.get('DASHBOARD_URL', 'http://localhost:3000').strip()

# Strike step sizes for each instrument (used for ATM calculation)
STRIKE_STEPS = {
    "NIFTY_50": 50,
    "BANKNIFTY": 100,
    "CRUDEOIL": 50,
    "NATURALGAS": 5,
}

def get_active_instruments():
    """Polls the dashboard to get the list of active instruments.
    Falls back to all instruments if the dashboard is unreachable."""
    try:
        resp = requests.get(f"{DASHBOARD_URL}/api/trading/active-instruments", timeout=3)
        if resp.status_code == 200:
            data = resp.json()
            return set(data.get("instruments", []))
    except Exception:
        pass
    return set(INSTRUMENTS)

NEWS_API_KEY = "pub_4a182e69591a4af796d131b0cb7b088d"

# --- Caches ---
NEWS_CACHE = {}
NEWS_CACHE_EXPIRY = 300
OI_HISTORY = {}  # instrument -> list of {timestamp, strike_oi_map} for velocity tracking
MAX_OI_HISTORY = 6  # Keep last 6 cycles (~30 seconds at 5s interval)

# --- Enhanced News Sentiment Engine v2 ---

# Instrument-specific multi-query configurations
NEWS_QUERIES = {
    "NIFTY_50": [
        {"query": "Nifty 50 Indian stock market", "category": "Business", "weight": 1.0},
        {"query": "Gift Nifty SGX Nifty pre market India", "category": "Business", "weight": 0.9},
        {"query": "India VIX volatility index fear gauge", "category": "Business", "weight": 0.85},
        {"query": "RBI monetary policy interest rate India", "category": "Business", "weight": 0.8},
        {"query": "FII DII flow India stock market", "category": "Business", "weight": 0.7},
        {"query": "S&P 500 Nasdaq Wall Street overnight futures", "category": "Business", "weight": 0.65},
        {"query": "India GDP CPI inflation WPI PMI data", "category": "Business", "weight": 0.6},
        {"query": "Reliance Infosys HDFC Bank quarterly results", "category": "Business", "weight": 0.5},
    ],
    "BANKNIFTY": [
        {"query": "Bank Nifty Indian banking sector", "category": "Business", "weight": 1.0},
        {"query": "Gift Nifty SGX Nifty pre market India", "category": "Business", "weight": 0.85},
        {"query": "India VIX volatility index", "category": "Business", "weight": 0.8},
        {"query": "RBI banking regulation NPA credit growth India", "category": "Business", "weight": 0.9},
        {"query": "HDFC Bank ICICI SBI Kotak results", "category": "Business", "weight": 0.7},
        {"query": "US banking sector crisis contagion risk", "category": "Business", "weight": 0.65},
        {"query": "India banking sector lending rates RBI circular", "category": "Business", "weight": 0.5},
    ],
    "CRUDEOIL": [
        {"query": "Crude Oil price WTI Brent", "category": "Business", "weight": 1.0},
        {"query": "OPEC production cut output decision", "category": "Business", "weight": 0.9},
        {"query": "US crude oil inventory EIA report", "category": "Business", "weight": 0.8},
        {"query": "Middle East geopolitical tension oil supply", "category": "World", "weight": 0.7},
        {"query": "US dollar index DXY strength currency", "category": "Business", "weight": 0.65},
        {"query": "Russia oil sanctions supply disruption", "category": "World", "weight": 0.6},
        {"query": "China oil demand imports PMI", "category": "Business", "weight": 0.5},
    ],
    "NATURALGAS": [
        {"query": "Natural Gas price Henry Hub", "category": "Business", "weight": 1.0},
        {"query": "US natural gas storage EIA report", "category": "Business", "weight": 0.9},
        {"query": "European natural gas TTF price benchmark", "category": "Business", "weight": 0.75},
        {"query": "LNG exports imports demand supply", "category": "Business", "weight": 0.7},
        {"query": "weather forecast heating cooling demand energy", "category": "Science", "weight": 0.6},
        {"query": "US natural gas rig count production", "category": "Business", "weight": 0.5},
    ],
}

# Weighted keyword dictionaries per instrument category
BULLISH_KEYWORDS_EQUITY = {
    # Strong bullish (weight 2)
    "rally": 2, "surge": 2, "breakout": 2, "record high": 2, "all-time high": 2,
    "rate cut": 2, "fii buying": 2, "strong earnings": 2, "beat estimates": 2,
    # Gift Nifty / Pre-market signals (weight 2)
    "gift nifty positive": 2, "gift nifty higher": 2, "gift nifty green": 2,
    "sgx nifty higher": 2, "pre market positive": 2,
    # VIX signals (weight 2 for low/falling VIX = bullish)
    "vix falls": 2, "vix drops": 2, "vix low": 2, "vix decline": 2, "volatility eases": 2,
    # US market overnight (weight 1-2)
    "wall street rally": 2, "s&p 500 gains": 2, "nasdaq rally": 2, "us futures positive": 2,
    "dow jones rise": 1, "us market higher": 1,
    # India macro (weight 2)
    "gdp growth": 2, "cpi falls": 2, "inflation eases": 2, "pmi expansion": 2,
    "manufacturing pmi": 1, "services pmi": 1,
    # Moderate bullish (weight 1)
    "gain": 1, "rise": 1, "bullish": 1, "positive": 1, "growth": 1,
    "recovery": 1, "uptrend": 1, "buying": 1, "inflow": 1, "upgrade": 1,
    "outperform": 1, "optimism": 1, "boost": 1, "strong": 1,
}
BEARISH_KEYWORDS_EQUITY = {
    # Strong bearish (weight 2)
    "crash": 2, "plunge": 2, "sell-off": 2, "rate hike": 2, "fii selling": 2,
    "miss estimates": 2, "recession": 2, "crisis": 2, "collapse": 2,
    # Gift Nifty / Pre-market signals (weight 2)
    "gift nifty negative": 2, "gift nifty lower": 2, "gift nifty red": 2,
    "sgx nifty lower": 2, "pre market negative": 2,
    # VIX signals (weight 2 for high/rising VIX = bearish)
    "vix spikes": 2, "vix surges": 2, "vix high": 2, "vix rises": 2, "volatility spikes": 2,
    "fear gauge": 1, "vix above 20": 2, "vix above 25": 2,
    # US market overnight (weight 1-2)
    "wall street crash": 2, "s&p 500 falls": 2, "nasdaq crash": 2, "us futures negative": 2,
    "dow jones fall": 1, "us market lower": 1, "wall street sell-off": 2,
    # India macro (weight 2)
    "gdp slows": 2, "cpi rises": 2, "inflation surges": 2, "pmi contraction": 2,
    "stagflation": 2, "fiscal deficit": 1,
    # Moderate bearish (weight 1)
    "fall": 1, "drop": 1, "decline": 1, "bearish": 1, "negative": 1,
    "weak": 1, "downtrend": 1, "selling": 1, "outflow": 1, "downgrade": 1,
    "underperform": 1, "concern": 1, "risk": 1, "pressure": 1, "slump": 1,
}

BULLISH_KEYWORDS_BANKING = {
    **BULLISH_KEYWORDS_EQUITY,
    "credit growth": 2, "npa reduction": 2, "loan growth": 2,
    "deposit growth": 1, "net interest margin": 1, "nim expansion": 2,
    # Banking-specific
    "casa ratio": 1, "retail lending": 1, "bank profit": 2,
}
BEARISH_KEYWORDS_BANKING = {
    **BEARISH_KEYWORDS_EQUITY,
    "npa increase": 2, "bad loans": 2, "provisioning": 1,
    "asset quality": 1, "nim compression": 2, "moratorium": 2,
    # US banking contagion
    "us bank crisis": 2, "banking contagion": 2, "bank run": 2,
    "silicon valley bank": 2, "bank failure": 2, "credit suisse": 1,
    "global banking risk": 1,
}

BULLISH_KEYWORDS_CRUDE = {
    "supply cut": 2, "opec cut": 2, "production cut": 2, "demand surge": 2,
    "inventory draw": 2, "stockpile decline": 2, "geopolitical tension": 1,
    "supply disruption": 2, "sanctions": 1, "rally": 2, "surge": 2,
    "gain": 1, "rise": 1, "bullish": 1, "positive": 1, "strong demand": 2,
    "china recovery": 1, "refinery demand": 1,
    # DXY / Dollar (inverse correlation — dollar weakness = crude bullish)
    "dollar weakness": 2, "dollar falls": 2, "dxy falls": 2, "dollar decline": 1,
    # Russia/sanctions
    "russia sanctions": 2, "russia oil ban": 2, "russia supply cut": 2,
    "pipeline disruption": 2, "export ban": 1,
}
BEARISH_KEYWORDS_CRUDE = {
    "supply increase": 2, "opec increase": 2, "production increase": 2,
    "demand weak": 2, "inventory build": 2, "stockpile increase": 2,
    "oversupply": 2, "glut": 2, "crash": 2, "plunge": 2, "sell-off": 2,
    "fall": 1, "drop": 1, "decline": 1, "bearish": 1, "weak demand": 2,
    "recession": 2, "china slowdown": 2,
    # DXY / Dollar (dollar strength = crude bearish)
    "dollar strength": 2, "dollar rally": 2, "dxy rises": 2, "dollar surge": 2,
    "strong dollar": 1,
    # Russia supply normalization
    "russia output increase": 1, "sanctions eased": 1, "sanctions lifted": 2,
}

BULLISH_KEYWORDS_NATGAS = {
    "cold weather": 2, "heating demand": 2, "storage draw": 2,
    "inventory decline": 2, "supply cut": 2, "export increase": 1,
    "lng demand": 1, "rally": 2, "surge": 2, "gain": 1, "rise": 1,
    "bullish": 1, "positive": 1, "production decline": 2, "rig count drop": 2,
    # European TTF / global gas
    "ttf price rise": 2, "european gas surge": 2, "europe gas crisis": 2,
    "lng shortage": 2, "cooling demand": 1, "summer heat": 1,
}
BEARISH_KEYWORDS_NATGAS = {
    "warm weather": 2, "mild winter": 2, "storage build": 2,
    "inventory increase": 2, "oversupply": 2, "production increase": 2,
    "crash": 2, "plunge": 2, "fall": 1, "drop": 1, "decline": 1,
    "bearish": 1, "weak demand": 2, "rig count increase": 1, "glut": 2,
    # European TTF / global gas
    "ttf price falls": 2, "european gas surplus": 2, "lng oversupply": 2,
    "mild summer": 1,
}

INSTRUMENT_KEYWORDS = {
    "NIFTY_50": (BULLISH_KEYWORDS_EQUITY, BEARISH_KEYWORDS_EQUITY),
    "BANKNIFTY": (BULLISH_KEYWORDS_BANKING, BEARISH_KEYWORDS_BANKING),
    "CRUDEOIL": (BULLISH_KEYWORDS_CRUDE, BEARISH_KEYWORDS_CRUDE),
    "NATURALGAS": (BULLISH_KEYWORDS_NATGAS, BEARISH_KEYWORDS_NATGAS),
}

# --- Event Calendar ---
# Key market events that affect sentiment interpretation
EVENT_CALENDAR = {
    # RBI Policy dates (bi-monthly, approximate)
    "rbi_policy": [
        {"date": "2026-02-06", "label": "RBI MPC Meeting", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-04-08", "label": "RBI MPC Meeting", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-06-03", "label": "RBI MPC Meeting", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-08-05", "label": "RBI MPC Meeting", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-10-07", "label": "RBI MPC Meeting", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-12-02", "label": "RBI MPC Meeting", "instruments": ["NIFTY_50", "BANKNIFTY"]},
    ],
    # US Fed FOMC dates
    "us_fed": [
        {"date": "2026-01-28", "label": "US Fed FOMC Decision", "instruments": ["NIFTY_50", "BANKNIFTY", "CRUDEOIL"]},
        {"date": "2026-03-18", "label": "US Fed FOMC Decision", "instruments": ["NIFTY_50", "BANKNIFTY", "CRUDEOIL"]},
        {"date": "2026-05-06", "label": "US Fed FOMC Decision", "instruments": ["NIFTY_50", "BANKNIFTY", "CRUDEOIL"]},
        {"date": "2026-06-17", "label": "US Fed FOMC Decision", "instruments": ["NIFTY_50", "BANKNIFTY", "CRUDEOIL"]},
        {"date": "2026-07-29", "label": "US Fed FOMC Decision", "instruments": ["NIFTY_50", "BANKNIFTY", "CRUDEOIL"]},
        {"date": "2026-09-16", "label": "US Fed FOMC Decision", "instruments": ["NIFTY_50", "BANKNIFTY", "CRUDEOIL"]},
        {"date": "2026-11-04", "label": "US Fed FOMC Decision", "instruments": ["NIFTY_50", "BANKNIFTY", "CRUDEOIL"]},
        {"date": "2026-12-16", "label": "US Fed FOMC Decision", "instruments": ["NIFTY_50", "BANKNIFTY", "CRUDEOIL"]},
    ],
    # EIA Crude Oil Inventory (every Wednesday)
    "eia_crude": [
        {"recurrence": "wednesday", "label": "EIA Crude Oil Inventory Report", "instruments": ["CRUDEOIL"]},
    ],
    # EIA Natural Gas Storage (every Thursday)
    "eia_natgas": [
        {"recurrence": "thursday", "label": "EIA Natural Gas Storage Report", "instruments": ["NATURALGAS"]},
    ],
    # India GDP releases (approximate)
    "india_gdp": [
        {"date": "2026-02-28", "label": "India Q3 GDP Data", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-05-30", "label": "India Q4 GDP Data", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-08-29", "label": "India Q1 FY27 GDP Data", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-11-28", "label": "India Q2 FY27 GDP Data", "instruments": ["NIFTY_50", "BANKNIFTY"]},
    ],
    # India CPI Inflation (monthly, ~12th of each month)
    "india_cpi": [
        {"date": "2026-01-13", "label": "India CPI Inflation Data", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-02-12", "label": "India CPI Inflation Data", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-03-12", "label": "India CPI Inflation Data", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-04-14", "label": "India CPI Inflation Data", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-05-12", "label": "India CPI Inflation Data", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-06-12", "label": "India CPI Inflation Data", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-07-13", "label": "India CPI Inflation Data", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-08-12", "label": "India CPI Inflation Data", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-09-14", "label": "India CPI Inflation Data", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-10-13", "label": "India CPI Inflation Data", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-11-12", "label": "India CPI Inflation Data", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-12-14", "label": "India CPI Inflation Data", "instruments": ["NIFTY_50", "BANKNIFTY"]},
    ],
    # India Manufacturing PMI (1st business day of each month)
    "india_pmi": [
        {"date": "2026-01-02", "label": "India Manufacturing PMI", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-02-02", "label": "India Manufacturing PMI", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-03-02", "label": "India Manufacturing PMI", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-04-01", "label": "India Manufacturing PMI", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-05-04", "label": "India Manufacturing PMI", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-06-01", "label": "India Manufacturing PMI", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-07-01", "label": "India Manufacturing PMI", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-08-03", "label": "India Manufacturing PMI", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-09-01", "label": "India Manufacturing PMI", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-10-01", "label": "India Manufacturing PMI", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-11-02", "label": "India Manufacturing PMI", "instruments": ["NIFTY_50", "BANKNIFTY"]},
        {"date": "2026-12-01", "label": "India Manufacturing PMI", "instruments": ["NIFTY_50", "BANKNIFTY"]},
    ],
    # NIFTY/BANKNIFTY weekly expiry (every Thursday)
    "weekly_expiry": [
        {"recurrence": "thursday", "label": "Weekly Options Expiry", "instruments": ["NIFTY_50", "BANKNIFTY"]},
    ],
    # Baker Hughes Rig Count (every Friday)
    "rig_count": [
        {"recurrence": "friday", "label": "Baker Hughes Rig Count", "instruments": ["CRUDEOIL", "NATURALGAS"]},
    ],
    # OPEC+ meetings (approximate)
    "opec": [
        {"date": "2026-03-05", "label": "OPEC+ Meeting", "instruments": ["CRUDEOIL"]},
        {"date": "2026-06-04", "label": "OPEC+ Meeting", "instruments": ["CRUDEOIL"]},
        {"date": "2026-09-03", "label": "OPEC+ Meeting", "instruments": ["CRUDEOIL"]},
        {"date": "2026-12-03", "label": "OPEC+ Meeting", "instruments": ["CRUDEOIL"]},
    ],
}

def get_upcoming_events(instrument, days_ahead=3):
    """Get upcoming market events relevant to this instrument within N days."""
    today = datetime.now().date()
    today_weekday = today.strftime("%A").lower()
    upcoming = []

    for category, events in EVENT_CALENDAR.items():
        for event in events:
            if instrument not in event.get("instruments", []):
                continue

            # Check recurring events (weekly)
            if "recurrence" in event:
                if event["recurrence"] == today_weekday:
                    upcoming.append({"label": event["label"], "date": "Today", "category": category})
                # Check if tomorrow matches
                tomorrow_weekday = (today + timedelta(days=1)).strftime("%A").lower()
                if event["recurrence"] == tomorrow_weekday:
                    upcoming.append({"label": event["label"], "date": "Tomorrow", "category": category})
                continue

            # Check fixed-date events
            if "date" in event:
                try:
                    event_date = datetime.strptime(event["date"], "%Y-%m-%d").date()
                    delta = (event_date - today).days
                    if 0 <= delta <= days_ahead:
                        date_label = "Today" if delta == 0 else ("Tomorrow" if delta == 1 else f"In {delta} days")
                        upcoming.append({"label": event["label"], "date": date_label, "category": category})
                except ValueError:
                    continue

    return upcoming


def score_article_text(text, bullish_kw, bearish_kw):
    """Score a single article's text using weighted keyword matching.
    Returns (bullish_score, bearish_score) as weighted sums."""
    if not text:
        return 0, 0
    text_lower = text.lower()
    bull_score = sum(weight for kw, weight in bullish_kw.items() if kw in text_lower)
    bear_score = sum(weight for kw, weight in bearish_kw.items() if kw in text_lower)
    return bull_score, bear_score


def fetch_news_sentiment(instrument_name):
    """Enhanced news sentiment: multi-query, weighted keywords, event awareness."""
    current_time = time.time()
    if instrument_name in NEWS_CACHE and (current_time - NEWS_CACHE[instrument_name]["timestamp"] < NEWS_CACHE_EXPIRY):
        print(f"  Using cached news for {instrument_name}.")
        return NEWS_CACHE[instrument_name]["data"]

    print(f"  Fetching enhanced news for {instrument_name}...")
    queries = NEWS_QUERIES.get(instrument_name, [{"query": instrument_name.replace('_', ' '), "category": "Business", "weight": 1.0}])
    bullish_kw, bearish_kw = INSTRUMENT_KEYWORDS.get(instrument_name, (BULLISH_KEYWORDS_EQUITY, BEARISH_KEYWORDS_EQUITY))

    all_articles = []
    query_results = []

    for q in queries:
        time.sleep(1)  # Rate limit between queries
        query_str = q["query"]
        category = q.get("category", "Business")
        query_weight = q.get("weight", 1.0)
        url = f"https://newsdata.io/api/1/latest?q={query_str}&country=in&category={category}&apikey={NEWS_API_KEY}"

        try:
            response = requests.get(url, timeout=10)
            response.raise_for_status()
            news_data = response.json()
            articles = news_data.get("results", [])
            query_results.append({"query": query_str, "count": len(articles), "weight": query_weight})

            for article in articles:
                title = article.get("title", "")
                desc = article.get("description", "")
                combined_text = f"{title} {desc}"
                api_sentiment = article.get("sentiment", "neutral")

                # Weighted keyword scoring
                bull_score, bear_score = score_article_text(combined_text, bullish_kw, bearish_kw)

                # Also factor in the API's own sentiment label
                if api_sentiment == "positive":
                    bull_score += 1
                elif api_sentiment == "negative":
                    bear_score += 1

                all_articles.append({
                    "title": title[:120],
                    "source": article.get("source_name", "Unknown"),
                    "bull_score": bull_score * query_weight,
                    "bear_score": bear_score * query_weight,
                    "net_score": (bull_score - bear_score) * query_weight,
                    "query": query_str,
                })

        except Exception as e:
            print(f"    Error fetching query '{query_str}': {e}")
            query_results.append({"query": query_str, "count": 0, "weight": query_weight, "error": str(e)})

    # Aggregate scores
    total_bull = sum(a["bull_score"] for a in all_articles)
    total_bear = sum(a["bear_score"] for a in all_articles)
    total_articles = len(all_articles)
    net_score = total_bull - total_bear

    # Determine sentiment with thresholds
    if total_articles == 0:
        sentiment = "Neutral"
        confidence = 0
    elif net_score > 3:
        sentiment = "Bullish"
        confidence = min(100, int(net_score * 8))
    elif net_score < -3:
        sentiment = "Bearish"
        confidence = min(100, int(abs(net_score) * 8))
    else:
        sentiment = "Neutral"
        confidence = max(0, 50 - int(abs(net_score) * 10))

    # Strength based on article count and score magnitude
    if total_articles > 15 and abs(net_score) > 5:
        strength = "Strong"
    elif total_articles > 5 and abs(net_score) > 2:
        strength = "Moderate"
    elif total_articles > 0:
        strength = "Mild"
    else:
        strength = "Weak"

    # Get upcoming events
    events = get_upcoming_events(instrument_name)
    event_flags = []
    for ev in events:
        event_flags.append(f"{ev['label']} ({ev['date']})")

    # Top articles (most impactful)
    sorted_articles = sorted(all_articles, key=lambda a: abs(a["net_score"]), reverse=True)
    top_articles = sorted_articles[:5]

    result = {
        "sentiment": sentiment,
        "strength": strength,
        "confidence": confidence,
        "total_articles": total_articles,
        "bull_score": round(total_bull, 1),
        "bear_score": round(total_bear, 1),
        "net_score": round(net_score, 1),
        "queries_used": len(queries),
        "query_results": query_results,
        "event_flags": event_flags,
        "top_articles": [{"title": a["title"], "source": a["source"], "score": round(a["net_score"], 1)} for a in top_articles],
    }

    print(f"    News: {sentiment} ({strength}, conf={confidence}%) from {total_articles} articles across {len(queries)} queries.")
    if event_flags:
        print(f"    Events: {', '.join(event_flags)}")
    NEWS_CACHE[instrument_name] = {"timestamp": current_time, "data": result}
    return result


# --- Data Loading ---

def load_option_chain(instrument_name):
    """Loads the latest option chain data."""
    filepath = os.path.join(DATA_DIR, f"option_chain_{instrument_name.lower()}.json")
    if os.path.exists(filepath):
        try:
            with open(filepath, 'r') as f:
                content = f.read().strip()
                if not content:
                    print(f"  [WARNING] Option chain file is empty: {filepath}")
                    return None
                return json.loads(content)
        except json.JSONDecodeError as e:
            print(f"  [ERROR] Invalid JSON in option chain {filepath}: {e}")
            return None
        except Exception as e:
            print(f"  [ERROR] Failed to read option chain {filepath}: {e}")
            return None
    else:
        print(f"  [WARNING] Option chain file not found: {filepath}")
    return None

def load_analyzer_output(instrument_name):
    """Loads the latest analyzer output for a given instrument."""
    filepath = os.path.join(DATA_DIR, f"analyzer_output_{instrument_name.lower()}.json")
    if os.path.exists(filepath):
        try:
            with open(filepath, 'r') as f:
                content = f.read().strip()
                if not content:
                    print(f"  [WARNING] Analyzer output file is empty: {filepath}")
                    return None
                return json.loads(content)
        except json.JSONDecodeError as e:
            print(f"  [ERROR] Invalid JSON in analyzer output {filepath}: {e}")
            return None
        except Exception as e:
            print(f"  [ERROR] Failed to read analyzer output {filepath}: {e}")
            return None
    else:
        print(f"  [WARNING] Analyzer output file not found: {filepath}")
    return None

def save_ai_decision(instrument_name, decision):
    """Saves the AI decision to a JSON file."""
    filepath = os.path.join(DATA_DIR, f"ai_decision_{instrument_name.lower()}.json")
    with open(filepath, 'w') as f:
        json.dump(decision, f, indent=2)


# --- ATM & Price Helpers ---

def find_atm_strike(ltp, instrument):
    """Find the At-The-Money strike price closest to LTP."""
    step = STRIKE_STEPS.get(instrument, 50)
    return round(ltp / step) * step

def get_strike_data(oc, strike):
    """Get CE and PE data for a specific strike from option chain."""
    if not oc or "oc" not in oc:
        return None, None
    strike_str = str(strike)
    # Try exact match first
    strike_data = oc["oc"].get(strike_str)
    if not strike_data:
        # Try float format (some instruments use decimal keys)
        for key in oc["oc"]:
            try:
                if abs(float(key) - strike) < 0.01:
                    strike_data = oc["oc"][key]
                    break
            except ValueError:
                continue
    if not strike_data:
        return None, None
    return strike_data.get("ce"), strike_data.get("pe")


# --- Wall Strength Analysis ---

def analyze_wall_strength(oc, level, wall_type, instrument):
    """
    Analyze the strength of a support/resistance wall.
    Returns: {strength: 0-100, oi, oi_change, volume, iv, prediction: 'BREAKOUT'|'BOUNCE', 
              probability: 0-100, evidence: [str]}
    """
    result = {
        "level": level,
        "strength": 50,
        "oi": 0,
        "oi_change": 0,
        "oi_change_pct": 0,
        "volume": 0,
        "iv": 0,
        "prediction": "UNCERTAIN",
        "probability": 50,
        "evidence": []
    }

    if not oc or "oc" not in oc:
        return result

    # Find the strike data at this level
    ce_data, pe_data = get_strike_data(oc, level)

    if wall_type == "resistance":
        # Resistance is defined by Call OI at this level
        data = ce_data
        if not data:
            result["evidence"].append("No call data at this level")
            return result
        result["oi"] = data.get("oi", 0)
        prev_oi = data.get("previous_oi", 0)
        result["oi_change"] = result["oi"] - prev_oi
        result["volume"] = data.get("volume", 0)
        result["iv"] = data.get("implied_volatility", 0)

        if prev_oi > 0:
            result["oi_change_pct"] = round((result["oi_change"] / prev_oi) * 100, 1)

        # Strength scoring for resistance
        strength_score = 50
        evidence = []

        # Factor 1: Absolute OI (higher = stronger wall)
        # Compare to average OI across all strikes
        all_ce_oi = [v.get("ce", {}).get("oi", 0) for v in oc["oc"].values() if v.get("ce")]
        avg_oi = sum(all_ce_oi) / max(len(all_ce_oi), 1)
        if avg_oi > 0:
            oi_ratio = result["oi"] / avg_oi
            if oi_ratio > 3:
                strength_score += 25
                evidence.append(f"Very high Call OI ({result['oi']:,}) — {oi_ratio:.1f}x average")
            elif oi_ratio > 1.5:
                strength_score += 15
                evidence.append(f"Above-average Call OI ({result['oi']:,})")
            else:
                strength_score -= 10
                evidence.append(f"Below-average Call OI ({result['oi']:,})")

        # Factor 2: OI Change direction (increasing = wall building, decreasing = crumbling)
        if result["oi_change"] > 0:
            strength_score += 15
            evidence.append(f"Call OI increasing +{result['oi_change']:,} (wall building)")
        elif result["oi_change"] < 0:
            strength_score -= 20
            evidence.append(f"Call OI decreasing {result['oi_change']:,} (wall crumbling)")
        else:
            evidence.append("Call OI unchanged")

        # Factor 3: Volume (high volume at resistance = active defense)
        all_ce_vol = [v.get("ce", {}).get("volume", 0) for v in oc["oc"].values() if v.get("ce")]
        avg_vol = sum(all_ce_vol) / max(len(all_ce_vol), 1)
        if avg_vol > 0 and result["volume"] > avg_vol * 2:
            strength_score += 10
            evidence.append(f"High volume {result['volume']:,} at resistance (active defense)")
        elif avg_vol > 0 and result["volume"] > avg_vol:
            strength.append if False else None  # skip
            evidence.append(f"Moderate volume at resistance")

        # Clamp strength
        result["strength"] = max(0, min(100, strength_score))

        # Prediction: BREAKOUT if wall is weak, BOUNCE if wall is strong
        if result["strength"] < 35:
            result["prediction"] = "BREAKOUT"
            result["probability"] = min(85, 50 + (35 - result["strength"]))
            evidence.append("Resistance wall is WEAK — breakout likely")
        elif result["strength"] > 65:
            result["prediction"] = "BOUNCE"
            result["probability"] = min(85, 50 + (result["strength"] - 65))
            evidence.append("Resistance wall is STRONG — bounce likely")
        else:
            result["prediction"] = "UNCERTAIN"
            result["probability"] = 50
            evidence.append("Resistance wall at moderate strength — could go either way")

        result["evidence"] = evidence

    elif wall_type == "support":
        # Support is defined by Put OI at this level
        data = pe_data
        if not data:
            result["evidence"].append("No put data at this level")
            return result
        result["oi"] = data.get("oi", 0)
        prev_oi = data.get("previous_oi", 0)
        result["oi_change"] = result["oi"] - prev_oi
        result["volume"] = data.get("volume", 0)
        result["iv"] = data.get("implied_volatility", 0)

        if prev_oi > 0:
            result["oi_change_pct"] = round((result["oi_change"] / prev_oi) * 100, 1)

        strength_score = 50
        evidence = []

        all_pe_oi = [v.get("pe", {}).get("oi", 0) for v in oc["oc"].values() if v.get("pe")]
        avg_oi = sum(all_pe_oi) / max(len(all_pe_oi), 1)
        if avg_oi > 0:
            oi_ratio = result["oi"] / avg_oi
            if oi_ratio > 3:
                strength_score += 25
                evidence.append(f"Very high Put OI ({result['oi']:,}) — {oi_ratio:.1f}x average")
            elif oi_ratio > 1.5:
                strength_score += 15
                evidence.append(f"Above-average Put OI ({result['oi']:,})")
            else:
                strength_score -= 10
                evidence.append(f"Below-average Put OI ({result['oi']:,})")

        if result["oi_change"] > 0:
            strength_score += 15
            evidence.append(f"Put OI increasing +{result['oi_change']:,} (support building)")
        elif result["oi_change"] < 0:
            strength_score -= 20
            evidence.append(f"Put OI decreasing {result['oi_change']:,} (support crumbling)")
        else:
            evidence.append("Put OI unchanged")

        all_pe_vol = [v.get("pe", {}).get("volume", 0) for v in oc["oc"].values() if v.get("pe")]
        avg_vol = sum(all_pe_vol) / max(len(all_pe_vol), 1)
        if avg_vol > 0 and result["volume"] > avg_vol * 2:
            strength_score += 10
            evidence.append(f"High volume {result['volume']:,} at support (active defense)")
        elif avg_vol > 0 and result["volume"] > avg_vol:
            evidence.append(f"Moderate volume at support")

        result["strength"] = max(0, min(100, strength_score))

        if result["strength"] < 35:
            result["prediction"] = "BREAKDOWN"
            result["probability"] = min(85, 50 + (35 - result["strength"]))
            evidence.append("Support wall is WEAK — breakdown likely")
        elif result["strength"] > 65:
            result["prediction"] = "BOUNCE"
            result["probability"] = min(85, 50 + (result["strength"] - 65))
            evidence.append("Support wall is STRONG — bounce likely")
        else:
            result["prediction"] = "UNCERTAIN"
            result["probability"] = 50
            evidence.append("Support wall at moderate strength — could go either way")

        result["evidence"] = evidence

    return result


# --- IV Assessment ---

def assess_iv(oc, atm_strike, instrument):
    """Assess if ATM IV is fair, cheap, or expensive."""
    ce_data, pe_data = get_strike_data(oc, atm_strike)
    atm_iv_ce = ce_data.get("implied_volatility", 0) if ce_data else 0
    atm_iv_pe = pe_data.get("implied_volatility", 0) if pe_data else 0
    atm_iv = max(atm_iv_ce, atm_iv_pe)

    # Compare ATM IV to average IV across nearby strikes
    all_ivs = []
    for v in oc.get("oc", {}).values():
        if v.get("ce", {}).get("implied_volatility"):
            all_ivs.append(v["ce"]["implied_volatility"])
        if v.get("pe", {}).get("implied_volatility"):
            all_ivs.append(v["pe"]["implied_volatility"])

    if not all_ivs:
        return {"atm_iv": atm_iv, "assessment": "UNKNOWN", "detail": "No IV data available"}

    avg_iv = sum(all_ivs) / len(all_ivs)
    iv_ratio = atm_iv / avg_iv if avg_iv > 0 else 1

    if iv_ratio > 1.3:
        return {"atm_iv": round(atm_iv, 1), "assessment": "EXPENSIVE", "detail": f"ATM IV {atm_iv:.1f}% is {((iv_ratio-1)*100):.0f}% above average — options overpriced"}
    elif iv_ratio < 0.8:
        return {"atm_iv": round(atm_iv, 1), "assessment": "CHEAP", "detail": f"ATM IV {atm_iv:.1f}% is below average — options fairly priced"}
    else:
        return {"atm_iv": round(atm_iv, 1), "assessment": "FAIR", "detail": f"ATM IV {atm_iv:.1f}% is near average — fair pricing"}


# --- Theta Assessment ---

def assess_theta(oc, atm_strike, expiry_str):
    """Assess theta decay risk based on days to expiry and ATM theta."""
    ce_data, pe_data = get_strike_data(oc, atm_strike)
    theta_ce = abs(ce_data.get("greeks", {}).get("theta", 0)) if ce_data else 0
    theta_pe = abs(pe_data.get("greeks", {}).get("theta", 0)) if pe_data else 0
    theta = max(theta_ce, theta_pe)

    # Try to parse expiry
    days_to_expiry = None
    if expiry_str:
        try:
            # Try multiple date formats
            for fmt in ["%Y-%m-%d", "%d-%m-%Y", "%Y-%m-%d %H:%M:%S"]:
                try:
                    expiry_date = datetime.strptime(expiry_str, fmt)
                    days_to_expiry = (expiry_date - datetime.now()).days
                    break
                except ValueError:
                    continue
        except Exception:
            pass

    warning = None
    if days_to_expiry is not None:
        if days_to_expiry <= 1:
            warning = f"CRITICAL: Expiry tomorrow — theta decay is extreme"
        elif days_to_expiry <= 2:
            warning = f"HIGH RISK: {days_to_expiry} days to expiry — theta accelerating fast"
        elif days_to_expiry <= 4:
            warning = f"CAUTION: {days_to_expiry} days to expiry — theta decay significant"
    
    return {
        "theta_per_day": round(theta, 2),
        "days_to_expiry": days_to_expiry,
        "warning": warning
    }


# --- Trade Setup Generator ---

def generate_trade_setup(oc, ltp, atm_strike, trade_direction, instrument,
                         support_analysis, resistance_analysis, iv_info, theta_info):
    """Generate a complete trade setup with entry, target, SL, and risk:reward."""
    step = STRIKE_STEPS.get(instrument, 50)
    
    if trade_direction == "GO_CALL":
        # For CALL buy: ATM CE
        ce_data, _ = get_strike_data(oc, atm_strike)
        entry_price = ce_data.get("last_price", 0) if ce_data else 0
        delta = ce_data.get("greeks", {}).get("delta", 0.5) if ce_data else 0.5

        # Target: based on resistance analysis
        res_level = resistance_analysis.get("level", atm_strike + step * 2)
        distance_to_resistance = res_level - ltp

        if resistance_analysis.get("prediction") == "BREAKOUT":
            # If breakout likely, target is next resistance beyond
            target_move = distance_to_resistance * 1.5
            target_label = f"Breakout target beyond {res_level}"
        else:
            # If bounce likely, target is just below resistance
            target_move = distance_to_resistance * 0.8
            target_label = f"Bounce target near {res_level}"

        target_price = entry_price + (target_move * abs(delta)) if delta != 0 else entry_price * 1.3
        
        # SL: based on support analysis
        sup_level = support_analysis.get("level", atm_strike - step * 2)
        distance_to_support = ltp - sup_level
        sl_move = distance_to_support * 0.6
        sl_price = entry_price - (sl_move * abs(delta)) if delta != 0 else entry_price * 0.75

        # Ensure SL is not negative
        sl_price = max(sl_price, entry_price * 0.5)

        risk = entry_price - sl_price
        reward = target_price - entry_price
        rr_ratio = round(reward / risk, 1) if risk > 0 else 0

        return {
            "direction": "GO_CALL",
            "strike": atm_strike,
            "option_type": "CE",
            "entry_price": round(entry_price, 2),
            "target_price": round(target_price, 2),
            "target_pct": round(((target_price - entry_price) / entry_price) * 100, 1) if entry_price > 0 else 0,
            "stop_loss": round(sl_price, 2),
            "sl_pct": round(((entry_price - sl_price) / entry_price) * 100, 1) if entry_price > 0 else 0,
            "risk_reward": rr_ratio,
            "target_label": target_label,
            "delta": round(delta, 3),
            "resistance_level": res_level,
            "support_level": sup_level,
        }

    elif trade_direction == "GO_PUT":
        # For PUT buy: ATM PE
        _, pe_data = get_strike_data(oc, atm_strike)
        entry_price = pe_data.get("last_price", 0) if pe_data else 0
        delta = abs(pe_data.get("greeks", {}).get("delta", -0.5)) if pe_data else 0.5

        # Target: based on support analysis
        sup_level = support_analysis.get("level", atm_strike - step * 2)
        distance_to_support = ltp - sup_level

        if support_analysis.get("prediction") == "BREAKDOWN":
            target_move = distance_to_support * 1.5
            target_label = f"Breakdown target below {sup_level}"
        else:
            target_move = distance_to_support * 0.8
            target_label = f"Bounce target near {sup_level}"

        target_price = entry_price + (target_move * delta) if delta != 0 else entry_price * 1.3

        # SL: based on resistance analysis
        res_level = resistance_analysis.get("level", atm_strike + step * 2)
        distance_to_resistance = res_level - ltp
        sl_move = distance_to_resistance * 0.6
        sl_price = entry_price - (sl_move * delta) if delta != 0 else entry_price * 0.75

        sl_price = max(sl_price, entry_price * 0.5)

        risk = entry_price - sl_price
        reward = target_price - entry_price
        rr_ratio = round(reward / risk, 1) if risk > 0 else 0

        return {
            "direction": "GO_PUT",
            "strike": atm_strike,
            "option_type": "PE",
            "entry_price": round(entry_price, 2),
            "target_price": round(target_price, 2),
            "target_pct": round(((target_price - entry_price) / entry_price) * 100, 1) if entry_price > 0 else 0,
            "stop_loss": round(sl_price, 2),
            "sl_pct": round(((entry_price - sl_price) / entry_price) * 100, 1) if entry_price > 0 else 0,
            "risk_reward": rr_ratio,
            "target_label": target_label,
            "delta": round(delta, 3),
            "resistance_level": res_level,
            "support_level": sup_level,
        }

    return None


# --- Weighted Scoring Engine ---

def compute_weighted_score(oc_bias, news_sentiment, support_analysis, resistance_analysis,
                           iv_info, theta_info, pcr_ratio, analyzer_output):
    """
    Compute a weighted confidence score and trade direction.
    Returns: (direction: GO_CALL|GO_PUT|WAIT, confidence: 0-1, factors: dict)
    """
    # Factor scores: each ranges from -1 (bearish) to +1 (bullish), 0 = neutral
    factors = {}

    # 1. OI Support/Resistance (30% weight)
    sr_score = 0
    sup_strength = support_analysis.get("strength", 50)
    res_strength = resistance_analysis.get("strength", 50)
    sup_pred = support_analysis.get("prediction", "UNCERTAIN")
    res_pred = resistance_analysis.get("prediction", "UNCERTAIN")

    # Strong support + weak resistance = bullish
    if sup_strength > 60 and res_strength < 40:
        sr_score = 0.8
    elif sup_strength > 60 and res_pred == "BREAKOUT":
        sr_score = 0.9
    elif res_strength > 60 and sup_strength < 40:
        sr_score = -0.8
    elif res_strength > 60 and sup_pred == "BREAKDOWN":
        sr_score = -0.9
    elif sup_strength > res_strength:
        sr_score = 0.3
    elif res_strength > sup_strength:
        sr_score = -0.3
    factors["oi_support_resistance"] = {"score": sr_score, "weight": 0.30,
        "detail": f"Support: {sup_strength}/100 ({sup_pred}), Resistance: {res_strength}/100 ({res_pred})"}

    # 2. OI Change Momentum (25% weight)
    momentum_score = 0
    entry_signals = analyzer_output.get("entry_signals", [])
    real_time_signals = analyzer_output.get("real_time_signals", [])
    smart_money = analyzer_output.get("smart_money_signals", [])

    bullish_signals = 0
    bearish_signals = 0
    for sig in entry_signals + real_time_signals + smart_money:
        sig_lower = sig.lower()
        if any(kw in sig_lower for kw in ["bullish", "call buy", "put writing", "put short buildup"]):
            bullish_signals += 1
        if any(kw in sig_lower for kw in ["bearish", "put buy", "call writing", "call short buildup"]):
            bearish_signals += 1

    if bullish_signals > bearish_signals:
        momentum_score = min(1.0, (bullish_signals - bearish_signals) * 0.3)
    elif bearish_signals > bullish_signals:
        momentum_score = max(-1.0, -(bearish_signals - bullish_signals) * 0.3)
    factors["oi_momentum"] = {"score": momentum_score, "weight": 0.25,
        "detail": f"Bullish signals: {bullish_signals}, Bearish signals: {bearish_signals}"}

    # 3. IV Level (15% weight)
    iv_score = 0
    iv_assessment = iv_info.get("assessment", "UNKNOWN")
    if iv_assessment == "CHEAP":
        iv_score = 0.5  # Favorable for long options
    elif iv_assessment == "FAIR":
        iv_score = 0.2
    elif iv_assessment == "EXPENSIVE":
        iv_score = -0.5  # Unfavorable for long options
    factors["iv_level"] = {"score": iv_score, "weight": 0.15,
        "detail": iv_info.get("detail", "No IV data")}

    # 4. PCR Trend (10% weight)
    pcr_score = 0
    if pcr_ratio > 1.2:
        pcr_score = 0.7  # Bullish (more puts = support)
    elif pcr_ratio > 1.0:
        pcr_score = 0.3
    elif pcr_ratio < 0.8:
        pcr_score = -0.7  # Bearish
    elif pcr_ratio < 1.0:
        pcr_score = -0.3
    factors["pcr_trend"] = {"score": pcr_score, "weight": 0.10,
        "detail": f"PCR: {pcr_ratio:.2f}" + (" (Bullish)" if pcr_score > 0 else " (Bearish)" if pcr_score < 0 else " (Neutral)")}

    # 5. News Sentiment (10% weight) — enhanced with confidence and article count
    news_score = 0
    news_bias = news_sentiment.get("sentiment", "Neutral")
    news_strength = news_sentiment.get("strength", "Mild")
    news_confidence = news_sentiment.get("confidence", 0)
    total_articles = news_sentiment.get("total_articles", 0)
    # Use confidence-based multiplier instead of simple strength
    conf_mult = min(1.0, news_confidence / 80) if news_confidence > 0 else 0.3
    strength_mult = max(conf_mult, 1.0 if news_strength == "Strong" else 0.6 if news_strength == "Moderate" else 0.3)
    if news_bias == "Bullish":
        news_score = 0.5 * strength_mult
    elif news_bias == "Bearish":
        news_score = -0.5 * strength_mult
    # Boost weight if there are upcoming events
    event_flags = news_sentiment.get("event_flags", [])
    news_weight = 0.15 if event_flags else 0.10  # Increase news weight on event days
    detail_parts = [f"{news_bias} ({news_strength}, {news_confidence}% conf, {total_articles} articles)"]
    if event_flags:
        detail_parts.append(f"Events: {', '.join(event_flags[:2])}")
    factors["news_sentiment"] = {"score": news_score, "weight": news_weight,
        "detail": " | ".join(detail_parts)}

    # 6. Time to Expiry / Theta (10% weight)
    theta_score = 0
    dte = theta_info.get("days_to_expiry")
    if dte is not None:
        if dte <= 1:
            theta_score = -0.8  # Very bad for long options
        elif dte <= 2:
            theta_score = -0.5
        elif dte <= 4:
            theta_score = -0.2
        else:
            theta_score = 0.3  # Enough time
    factors["theta_risk"] = {"score": theta_score, "weight": 0.10,
        "detail": theta_info.get("warning") or f"{dte} days to expiry" if dte else "Expiry unknown"}

    # Compute weighted total
    total_score = sum(f["score"] * f["weight"] for f in factors.values())

    # Determine direction
    if total_score > 0.15:
        direction = "GO_CALL"
    elif total_score < -0.15:
        direction = "GO_PUT"
    else:
        direction = "WAIT"

    # Confidence: map absolute score to 0-1 range
    confidence = min(0.95, abs(total_score) * 1.5)
    # Minimum confidence of 0.3 if we have a direction
    if direction != "WAIT":
        confidence = max(0.3, confidence)

    return direction, round(confidence, 2), factors


# --- Risk Flags ---

def compute_risk_flags(iv_info, theta_info, support_analysis, resistance_analysis, trade_direction):
    """Generate risk flags for the trade."""
    flags = []

    # IV risk
    if iv_info.get("assessment") == "EXPENSIVE":
        flags.append({"type": "warning", "text": f"IV is elevated at {iv_info.get('atm_iv', 0)}% — risk of IV crush even if direction is right"})

    # Theta risk
    if theta_info.get("warning"):
        flags.append({"type": "danger", "text": theta_info["warning"]})

    # Wall strength risk
    if trade_direction == "GO_CALL" and resistance_analysis.get("strength", 50) > 70:
        flags.append({"type": "warning", "text": f"Strong resistance at {resistance_analysis.get('level')} — may cap upside"})
    if trade_direction == "GO_PUT" and support_analysis.get("strength", 50) > 70:
        flags.append({"type": "warning", "text": f"Strong support at {support_analysis.get('level')} — may cap downside"})

    # Weak floor/ceiling
    if trade_direction == "GO_CALL" and support_analysis.get("strength", 50) < 30:
        flags.append({"type": "danger", "text": f"Support at {support_analysis.get('level')} is weak — SL may get hit quickly"})
    if trade_direction == "GO_PUT" and resistance_analysis.get("strength", 50) < 30:
        flags.append({"type": "danger", "text": f"Resistance at {resistance_analysis.get('level')} is weak — SL may get hit quickly"})

    return flags


# --- Main Decision Function ---

def make_enhanced_decision(instrument, analyzer_output, oc, news_sentiment):
    """Makes an enhanced trading decision with breakout/bounce prediction and trade setup."""
    ltp = oc.get("last_price", 0) if oc else (analyzer_output.get("last_price", 0))
    atm_strike = find_atm_strike(ltp, instrument)
    main_support = analyzer_output.get("main_support", 0)
    main_resistance = analyzer_output.get("main_resistance", 0)

    # Analyze wall strengths
    support_analysis = analyze_wall_strength(oc, main_support, "support", instrument) if main_support else {
        "level": 0, "strength": 50, "prediction": "UNCERTAIN", "probability": 50, "evidence": ["No support level identified"],
        "oi": 0, "oi_change": 0, "oi_change_pct": 0, "volume": 0, "iv": 0
    }
    resistance_analysis = analyze_wall_strength(oc, main_resistance, "resistance", instrument) if main_resistance else {
        "level": 0, "strength": 50, "prediction": "UNCERTAIN", "probability": 50, "evidence": ["No resistance level identified"],
        "oi": 0, "oi_change": 0, "oi_change_pct": 0, "volume": 0, "iv": 0
    }

    # IV assessment
    iv_info = assess_iv(oc, atm_strike, instrument) if oc else {"atm_iv": 0, "assessment": "UNKNOWN", "detail": "No data"}

    # Theta assessment
    theta_info = assess_theta(oc, atm_strike, analyzer_output.get("target_expiry_date"))

    # PCR ratio
    total_call_oi = 0
    total_put_oi = 0
    if oc and "oc" in oc:
        for v in oc["oc"].values():
            if v.get("ce"):
                total_call_oi += v["ce"].get("oi", 0)
            if v.get("pe"):
                total_put_oi += v["pe"].get("oi", 0)
    pcr_ratio = total_put_oi / total_call_oi if total_call_oi > 0 else 0

    # Weighted scoring
    direction, confidence, factors = compute_weighted_score(
        analyzer_output.get("market_bias", "Neutral"),
        news_sentiment, support_analysis, resistance_analysis,
        iv_info, theta_info, pcr_ratio, analyzer_output
    )

    # Generate trade setup if we have a direction
    trade_setup = None
    if direction in ("GO_CALL", "GO_PUT"):
        trade_setup = generate_trade_setup(
            oc, ltp, atm_strike, direction, instrument,
            support_analysis, resistance_analysis, iv_info, theta_info
        )

    # Risk flags
    risk_flags = compute_risk_flags(iv_info, theta_info, support_analysis, resistance_analysis, direction)

    # Build rationale from top factors
    sorted_factors = sorted(factors.items(), key=lambda x: abs(x[1]["score"] * x[1]["weight"]), reverse=True)
    rationale_parts = []
    for name, f in sorted_factors[:3]:
        direction_word = "bullish" if f["score"] > 0 else "bearish" if f["score"] < 0 else "neutral"
        rationale_parts.append(f"{name.replace('_', ' ').title()}: {direction_word} — {f['detail']}")
    rationale = "; ".join(rationale_parts)

    # Map direction to legacy format
    legacy_decision = "GO" if direction in ("GO_CALL", "GO_PUT") else ("WAIT" if direction == "WAIT" else "NO-GO")
    legacy_trade_type = "CALL_BUY" if direction == "GO_CALL" else ("PUT_BUY" if direction == "GO_PUT" else "NONE")

    decision = {
        # Legacy fields (backward compatible)
        "instrument": instrument,
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "decision": legacy_decision,
        "trade_type": legacy_trade_type,
        "confidence_score": confidence,
        "rationale": rationale,
        "market_bias_oc": analyzer_output.get("market_bias"),
        "market_bias_news": news_sentiment.get("sentiment"),
        "active_strikes": analyzer_output.get("active_strikes"),
        "main_support": main_support,
        "main_resistance": main_resistance,
        "entry_signal_details": None,
        "news_summary": f"News: {news_sentiment.get('sentiment')} ({news_sentiment.get('strength')}, {news_sentiment.get('confidence', 0)}% conf from {news_sentiment.get('total_articles', 0)} articles)",
        "target_strike": analyzer_output.get("target_strike"),
        "target_expiry_date": analyzer_output.get("target_expiry_date"),

        # Enhanced fields
        "trade_direction": direction,
        "atm_strike": atm_strike,
        "ltp": ltp,
        "support_analysis": support_analysis,
        "resistance_analysis": resistance_analysis,
        "iv_assessment": iv_info,
        "theta_assessment": theta_info,
        "pcr_ratio": round(pcr_ratio, 2),
        "trade_setup": trade_setup,
        "risk_flags": risk_flags,
        "scoring_factors": {k: {"score": round(v["score"], 2), "weight": v["weight"], "detail": v["detail"]} for k, v in factors.items()},

        # Enhanced news sentiment data
        "news_detail": {
            "sentiment": news_sentiment.get("sentiment"),
            "strength": news_sentiment.get("strength"),
            "confidence": news_sentiment.get("confidence", 0),
            "total_articles": news_sentiment.get("total_articles", 0),
            "bull_score": news_sentiment.get("bull_score", 0),
            "bear_score": news_sentiment.get("bear_score", 0),
            "net_score": news_sentiment.get("net_score", 0),
            "queries_used": news_sentiment.get("queries_used", 0),
            "event_flags": news_sentiment.get("event_flags", []),
            "top_articles": news_sentiment.get("top_articles", []),
        },
    }

    return decision


# --- Main Loop ---

def main():
    print("Starting Enhanced AI Decision Engine v2...")
    print(f"Dashboard URL: {DASHBOARD_URL}")
    print(f"Instruments: {INSTRUMENTS}")
    print("=" * 60)

    while True:
        current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print(f"\n--- Decision Cycle at {current_time} ---")

        active_instruments = get_active_instruments()
        print(f"Active instruments: {list(active_instruments)}")

        for instrument in INSTRUMENTS:
            if instrument not in active_instruments:
                print(f"\n  SKIPPING {instrument} (disabled)")
                continue

            print(f"\n  Analyzing {instrument}...")
            analyzer_output = load_analyzer_output(instrument)
            oc = load_option_chain(instrument)

            if not analyzer_output:
                print(f"    No analyzer output for {instrument}. Waiting...")
                continue

            news_sentiment = fetch_news_sentiment(instrument)
            decision = make_enhanced_decision(instrument, analyzer_output, oc, news_sentiment)
            save_ai_decision(instrument, decision)

            # Print summary
            td = decision.get("trade_direction", "WAIT")
            conf = decision.get("confidence_score", 0)
            setup = decision.get("trade_setup")
            sup = decision.get("support_analysis", {})
            res = decision.get("resistance_analysis", {})

            print(f"    Direction: {td} | Confidence: {conf*100:.0f}%")
            print(f"    Support: {sup.get('level')} (Strength: {sup.get('strength')}/100, {sup.get('prediction')})")
            print(f"    Resistance: {res.get('level')} (Strength: {res.get('strength')}/100, {res.get('prediction')})")
            if setup:
                print(f"    Trade: {setup.get('option_type')} {setup.get('strike')} @ {setup.get('entry_price')}")
                print(f"    Target: {setup.get('target_price')} ({setup.get('target_pct')}%) | SL: {setup.get('stop_loss')} ({setup.get('sl_pct')}%)")
                print(f"    Risk:Reward = 1:{setup.get('risk_reward')}")
            for flag in decision.get("risk_flags", []):
                print(f"    [{flag['type'].upper()}] {flag['text']}")

        print("\nWaiting 5 seconds...")
        time.sleep(5)


if __name__ == "__main__":
    main()
