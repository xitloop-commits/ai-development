"""
Generate sharp custom .ico files for ATS desktop shortcuts.

Pipeline:
  1. Download Font Awesome 6 SVGs (done once, cached in startup/icons/)
  2. Node.js render_svgs.mjs renders each SVG to white PNGs via resvg-js
  3. Python composites white glyph PNG onto coloured rounded background
  4. Saves multi-size ICO
"""

import os
import subprocess
import sys
import urllib.request

from PIL import Image, ImageDraw, ImageFont

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.join(SCRIPT_DIR, "..")
ICONS_DIR = os.path.join(SCRIPT_DIR, "icons")
os.makedirs(ICONS_DIR, exist_ok=True)

# ── Step 1: Download SVGs ──────────────────────────────────────────────────
FA_BASE = "https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6/svgs/solid/"
SVG_NAMES = [
    "rocket",
    "server",
    "chart-line",
    "building-columns",
    "oil-can",
    "fire",
    "paper-plane",
    "compass",
]

for name in SVG_NAMES:
    path = os.path.join(ICONS_DIR, f"{name}.svg")
    if not os.path.exists(path):
        print(f"  Downloading {name}.svg ...")
        urllib.request.urlretrieve(FA_BASE + name + ".svg", path)

# ── Step 2: Render SVGs to PNGs via resvg-js ──────────────────────────────
print("Rendering SVGs with resvg-js ...")
result = subprocess.run(
    ["node", os.path.join(SCRIPT_DIR, "render_svgs.mjs")],
    cwd=PROJECT_ROOT,
    capture_output=True,
    text=True,
)
print(result.stdout.strip())
if result.returncode != 0:
    print("ERROR from render_svgs.mjs:")
    print(result.stderr)
    sys.exit(1)

# ── Step 3: Composite + save ICO ──────────────────────────────────────────
# (output_file, bg_rgb, svg_name, sub_label)
ICONS = [
    ("start_all.ico", (22, 140, 22), "rocket", "ALL"),
    ("api_server.ico", (25, 90, 185), "server", "SERVER"),
    ("tfa_nifty50.ico", (210, 75, 0), "chart-line", "NIFTY"),
    ("tfa_banknifty.ico", (110, 20, 170), "building-columns", "BANK"),
    ("tfa_crudeoil.ico", (185, 30, 30), "oil-can", "CRUDE"),
    ("tfa_naturalgas.ico", (0, 145, 135), "fire", "GAS"),
    ("tfa_bot.ico", (35, 55, 200), "paper-plane", "BOT"),
    ("launcher.ico", (210, 145, 10), "compass", "ATS"),
]

SIZES = [256, 48, 32, 16]  # largest first — Pillow needs this for ICO

LABEL_FONTS = [
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/calibrib.ttf",
    "C:/Windows/Fonts/segoeuib.ttf",
]


def get_font(size):
    for fp in LABEL_FONTS:
        if os.path.exists(fp):
            try:
                return ImageFont.truetype(fp, size)
            except Exception:
                pass
    return ImageFont.load_default()


def rounded_rect(draw, x0, y0, x1, y1, r, fill):
    draw.rectangle([x0 + r, y0, x1 - r, y1], fill=fill)
    draw.rectangle([x0, y0 + r, x1, y1 - r], fill=fill)
    for cx, cy in [(x0, y0), (x1 - 2 * r, y0), (x0, y1 - 2 * r), (x1 - 2 * r, y1 - 2 * r)]:
        draw.ellipse([cx, cy, cx + 2 * r, cy + 2 * r], fill=fill)


def centre_text(draw, text, font, cx, cy, fill):
    bb = draw.textbbox((0, 0), text, font=font)
    x = cx - (bb[2] - bb[0]) / 2 - bb[0]
    y = cy - (bb[3] - bb[1]) / 2 - bb[1]
    draw.text((x, y), text, fill=fill, font=font)


def make_frame(size, bg, svg_name, sub):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = max(size // 20, 1)
    r = max(size // 7, 2)
    rounded_rect(draw, pad, pad, size - pad, size - pad, r, bg + (255,))

    # Load pre-rendered white glyph PNG for this size
    glyph_path = os.path.join(ICONS_DIR, f"{svg_name}_{size}.png")
    glyph_raw = Image.open(glyph_path).convert("RGBA")

    if size >= 48:
        # glyph in upper portion, sub-label at bottom
        glyph_size = int(size * 0.58)
        glyph = glyph_raw.resize((glyph_size, glyph_size), Image.LANCZOS)
        gx = (size - glyph_size) // 2
        gy = int(size * 0.08)
        img.alpha_composite(glyph, (gx, gy))

        draw = ImageDraw.Draw(img)
        font = get_font(max(6, int(size * 0.17)))
        centre_text(draw, sub, font, size / 2, size * 0.84, (255, 255, 240, 220))
    else:
        # small: centred glyph only
        glyph_size = int(size * 0.68)
        glyph = glyph_raw.resize((glyph_size, glyph_size), Image.LANCZOS)
        gx = (size - glyph_size) // 2
        gy = (size - glyph_size) // 2
        img.alpha_composite(glyph, (gx, gy))

    return img


print("Building ICO files ...")
for fname, bg, svg_name, sub in ICONS:
    # Build each size as its own image
    frames = [make_frame(s, bg, svg_name, sub) for s in SIZES]

    out = os.path.join(ICONS_DIR, fname)

    # Save as ICO: Pillow needs each frame saved to a tmp PNG then combined
    # Simplest reliable method: save each frame to a BytesIO, re-open, combine
    import io

    pil_frames = []
    for frame in frames:
        buf = io.BytesIO()
        frame.save(buf, format="PNG")
        buf.seek(0)
        pil_frames.append(Image.open(buf).copy())

    pil_frames[0].save(
        out,
        format="ICO",
        append_images=pil_frames[1:],
        sizes=[(s, s) for s in SIZES],
    )
    size_kb = os.path.getsize(out) / 1024
    print(f"  Saved: {fname}  ({size_kb:.1f} KB)")

print("\nAll icons created.")
