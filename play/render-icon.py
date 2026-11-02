# Renders the Play Store icon (en-US/icon.png) from the launcher icon itself (res/drawable/ic_launcher_foreground.xml
# on the ic_launcher_background colour), cropped as a launcher shows it - the middle 72 of its 108 dp - so the store
# and the home screen show the same full-width trace. Full bleed and opaque, 512x512 32-bit: Play rounds the corners
# and adds the shadow itself. Run: python play/render-icon.py play/en-US/icon.png
import sys
from PIL import Image, ImageDraw

out = sys.argv[1]
K = 4                          # drawn 4x and scaled down, for smooth edges
S = 512 * K / 72.0             # dp -> pixels, for the 72 dp a launcher shows
def px(x, y): return ((x - 18) * S, (y - 18) * S)

trace = [(20, 70), (28, 66), (34, 72), (40, 50), (46, 74), (52, 30), (58, 76), (64, 58), (70, 70), (76, 62), (82, 72), (88, 68)]
img = Image.new("RGBA", (512 * K, 512 * K), (0x0a, 0x0d, 0x13, 255))
d = ImageDraw.Draw(img)
w = round(4 * S)
d.line([px(*p) for p in trace], fill=(0x4c, 0x8d, 0xff, 255), width=w, joint="curve")
for p in (trace[0], trace[-1]):   # round caps
    x, y = px(*p); d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=(0x4c, 0x8d, 0xff, 255))
img.resize((512, 512), Image.Resampling.LANCZOS).save(out)
