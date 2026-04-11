/**
 * Dhan Token Refresh — Automated Login + Token Save
 *
 * Dhan login flow:
 *   1. Enter phone number
 *   2. OTP sent to mobile → you type it
 *   3. Enter PIN (auto-filled)
 *   4. Grab access token → save to MongoDB
 *
 * Setup: Add these two lines to your .env file:
 *   DHAN_PHONE=your_mobile_number
 *   DHAN_PIN=your_4digit_pin
 *
 * Run:
 *   node scripts/dhan-token-refresh.mjs
 */

import { chromium } from "playwright";
import mongoose from "mongoose";
import readline from "readline";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const BROKER_ID = "dhan";
const DHAN_LOGIN_URL = "https://web.dhan.co/";

// ─── Helpers ────────────────────────────────────────────────────

function log(msg) {
  const time = new Date().toLocaleTimeString("en-IN");
  console.log(`[${time}] ${msg}`);
}

function askQuestion(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const phone = process.env.DHAN_PHONE;
  const pin = process.env.DHAN_PIN;
  const mongoUri = process.env.MONGODB_URI;

  if (!phone || !pin) {
    console.error(
      "\n[ERROR] DHAN_PHONE and DHAN_PIN must be set in your .env file.\n"
    );
    process.exit(1);
  }
  if (!mongoUri) {
    console.error("\n[ERROR] MONGODB_URI must be set in your .env file.\n");
    process.exit(1);
  }

  log("Starting Dhan token refresh...");

  const browser = await chromium.launch({
    headless: false,
    args: ["--start-maximized"],
  });

  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  try {
    // ── Step 1: Open Dhan login page ──────────────────────────
    log("Opening Dhan login page...");
    await page.goto(DHAN_LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    // ── Step 1b: Wait for full page render then dismiss QR ───
    log("Waiting for page to fully render...");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    // "Hide QR" requires a manual click (Angular event binding blocks automation)
    console.log("\n" + "=".repeat(52));
    console.log("  ACTION NEEDED: Click 'Hide QR' in the browser");
    console.log("=".repeat(52));
    await askQuestion("  After clicking 'Hide QR', press Enter here: ");
    await page.waitForTimeout(1000);

    // ── Step 2: Enter phone number ────────────────────────────
    log("Entering phone number...");
    const phoneField = await page.waitForSelector(
      'input[type="tel"], input[placeholder*="phone"], input[placeholder*="Phone"], input[placeholder*="mobile"], input[placeholder*="Mobile"], input[placeholder*="number"], input[type="number"], input[type="text"]',
      { timeout: 15000 }
    );
    await phoneField.fill(phone);
    await page.waitForTimeout(500);

    // Click "Send OTP" or "Get OTP" button
    log("Clicking Send OTP...");
    const otpBtn = await page.waitForSelector(
      'button:has-text("OTP"), button:has-text("otp"), button:has-text("Send"), button:has-text("Get"), button[type="submit"]',
      { timeout: 10000 }
    );
    await otpBtn.click();
    await page.waitForTimeout(3000);

    // ── Step 3: Wait for OTP inputs, focus first, then ask user ─
    log("Waiting for OTP input to appear...");

    // Wait for any input to appear on the new page
    await page.waitForTimeout(2000);

    // Dump all inputs to diagnose
    const inputsInfo = await page.evaluate(() =>
      [...document.querySelectorAll("input")].map(i => ({
        type: i.type,
        maxLength: i.maxLength,
        placeholder: i.placeholder,
        id: i.id,
        className: i.className.slice(0, 60),
      }))
    );
    log("Inputs on OTP page: " + JSON.stringify(inputsInfo));

    // Focus the first relevant input BEFORE asking user (keeps browser focused)
    const allInputs = await page.locator("input").all();
    if (allInputs.length > 0) {
      await allInputs[0].click();
      log("Clicked first input to focus it.");
    }

    console.log("\n" + "=".repeat(52));
    const otp = await askQuestion(
      "  OTP sent to your mobile — enter it here: "
    );
    console.log("=".repeat(52) + "\n");

    log("Typing OTP into browser...");

    // Re-focus and use pressSequentially (fires all keyboard events Angular needs)
    if (allInputs.length > 0) {
      await allInputs[0].click();
      await allInputs[0].pressSequentially(otp, { delay: 150 });
    }

    await page.waitForTimeout(1000);

    // Submit OTP
    try {
      const submitBtn = page.locator(
        'button:has-text("Verify"), button:has-text("Submit"), button:has-text("Login"), button:has-text("Proceed"), button:has-text("Continue"), button[type="submit"]'
      ).first();
      await submitBtn.click({ timeout: 5000 });
    } catch {
      await page.keyboard.press("Enter");
    }
    await page.waitForTimeout(3000);

    // ── Step 4: Enter PIN ─────────────────────────────────────
    log("Entering PIN...");
    try {
      await page.waitForTimeout(2000);

      const pinInputsInfo = await page.evaluate(() =>
        [...document.querySelectorAll("input")].map(i => ({
          type: i.type, maxLength: i.maxLength, placeholder: i.placeholder,
        }))
      );
      log("Inputs on PIN page: " + JSON.stringify(pinInputsInfo));

      // PIN uses 6 individual password boxes — type one digit per box
      const pinInputs = await page.locator('input[type="password"]').all();
      if (pinInputs.length >= pin.length) {
        log(`Typing PIN into ${pinInputs.length} individual boxes...`);
        for (let i = 0; i < pin.length; i++) {
          await pinInputs[i].click();
          await pinInputs[i].pressSequentially(pin[i], { delay: 100 });
        }
        log("PIN typed.");
      } else if (pinInputs.length > 0) {
        await pinInputs[0].click();
        await pinInputs[0].pressSequentially(pin, { delay: 100 });
        log("PIN typed into single field.");
      }

      await page.waitForTimeout(500);

      try {
        const pinSubmit = page.locator(
          'button:has-text("Login"), button:has-text("Submit"), button:has-text("Proceed"), button:has-text("Continue"), button[type="submit"]'
        ).first();
        await pinSubmit.click({ timeout: 5000 });
      } catch {
        await page.keyboard.press("Enter");
      }
      await page.waitForTimeout(4000);
    } catch (e) {
      log("PIN step error: " + e.message);
    }

    // ── Step 5: Let user navigate to token page, then extract ─
    log("Login successful!");
    console.log("\n" + "=".repeat(52));
    console.log("  Navigate to your access token page in the browser.");
    console.log("  (Profile / Settings / API Access — wherever the token is shown)");
    console.log("=".repeat(52));
    await askQuestion("  Once the token is visible on screen, press Enter here: ");

    await page.waitForTimeout(1000);

    // Record current URL for future automation
    const currentUrl = page.url();
    log("Current URL: " + currentUrl);

    // Try to extract from the page DOM first
    let accessToken = await extractTokenFromPage(page);

    // If not in DOM, check localStorage / sessionStorage
    if (!accessToken) {
      const storageData = await page.evaluate(() => {
        const result = {};
        for (const store of [localStorage, sessionStorage]) {
          for (const key of Object.keys(store)) {
            result[key] = store.getItem(key) || "";
          }
        }
        return result;
      });
      log("Storage snapshot: " + JSON.stringify(
        Object.fromEntries(Object.entries(storageData).map(([k, v]) => [k, v.slice(0, 80)]))
      ));

      // Search for token in storage
      for (const val of Object.values(storageData)) {
        if (!val) continue;
        if (val.length > 40 && /^[a-zA-Z0-9_.\-]+$/.test(val)) {
          accessToken = val;
          break;
        }
        try {
          const parsed = JSON.parse(val);
          for (const k of ["accessToken", "access_token", "token", "authToken", "jwtToken", "idToken"]) {
            if (parsed?.[k] && String(parsed[k]).length > 40) {
              accessToken = parsed[k];
              break;
            }
          }
        } catch {}
        if (accessToken) break;
      }
    }

    if (accessToken) {
      log(`Token found automatically (${accessToken.length} chars)!`);
    } else {
      log("Could not auto-extract — please copy and paste it manually.");
      console.log("\n" + "=".repeat(52));
      accessToken = await askQuestion("  Paste the access token here: ");
      console.log("=".repeat(52) + "\n");
    }

    if (!accessToken) {
      console.error("[ERROR] No access token obtained. Aborting.");
      process.exit(1);
    }

    log(`Token obtained (${accessToken.length} chars)`);

    // ── Step 6: Save to MongoDB ───────────────────────────────
    log("Saving token to MongoDB...");
    await mongoose.connect(mongoUri);

    const now = Date.now();
    const result = await mongoose.connection.db
      .collection("broker_configs")
      .updateOne(
        { brokerId: BROKER_ID },
        {
          $set: {
            "credentials.accessToken": accessToken,
            "credentials.updatedAt": now,
            "credentials.expiresIn": 86400000,
            "credentials.status": "valid",
            "connection.apiStatus": "connected",
            "connection.lastApiCall": now,
          },
        }
      );

    if (result.matchedCount === 0) {
      console.error(`[ERROR] No broker_config found with brokerId="${BROKER_ID}".`);
      process.exit(1);
    }

    log("Token saved to MongoDB successfully!");
    log(`Expires at: ${new Date(now + 86400000).toLocaleString("en-IN")}`);
    console.log("\n  Done! Dhan access token has been refreshed.\n");
  } catch (err) {
    console.error("\n[ERROR]", err.message);
    process.exit(1);
  } finally {
    await browser.close();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  }
}

// ─── Token Extraction ────────────────────────────────────────────

async function extractTokenFromPage(page) {
  return page.evaluate(() => {
    const selectors = [
      'input[name*="token"]',
      'input[id*="token"]',
      'input[name*="access"]',
      ".access-token",
      "[data-testid*='token']",
      "code",
      "pre",
    ];

    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const val = el.value || el.textContent?.trim();
        if (val && val.length > 40 && /^[a-zA-Z0-9_.\-]+$/.test(val)) {
          return val;
        }
      }
    }

    // Any input with a long value
    for (const input of document.querySelectorAll("input")) {
      if (input.value && input.value.length > 60) return input.value;
    }

    return null;
  });
}

main();
