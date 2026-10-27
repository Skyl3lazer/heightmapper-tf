"""Low-sun hillshades of the same window from several exports, water tinted, side by side. usage: shade_pair.py out.png y x size scale png..."""
import sys, json, struct
import numpy as np
from PIL import Image, ImageDraw
Image.MAX_IMAGE_PIXELS = None

def read(path):
    data = open(path, 'rb').read(); pos, meta = 8, None
    while pos < len(data):
        n, k = struct.unpack('>I4s', data[pos:pos + 8])
        if k == b'tEXt':
            key, _, v = data[pos + 8:pos + 8 + n].partition(b'\0')
            if key == b'Description': meta = json.loads(v)
        if k == b'IDAT': break
        pos += 12 + n
    return np.asarray(Image.open(path)).astype(np.float64), meta

out, y, x, size, scale = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
tiles = []
for path in sys.argv[6:]:
    raw, m = read(path)
    g = (m['blackMeters'] + raw[y:y + size, x:x + size] / 65535 * (m['whiteMeters'] - m['blackMeters'])) * m['heightScale'] - m['waterLevel']
    gy, gx = np.gradient(g, 4.0)
    az, alt = np.radians(315), np.radians(25)
    slope = np.arctan(np.hypot(gx, gy) * 3)              # heights tripled so a 2 m step shows
    aspect = np.arctan2(-gx, gy)
    shade = np.clip(np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect), 0, 1)
    rgb = np.stack([shade * 235, shade * 225, shade * 200], -1)
    w = g < 0
    rgb[w] = np.stack([40 + 60 * shade[w], 90 + 70 * shade[w], 140 + 80 * shade[w]], -1)
    im = Image.fromarray(rgb.astype(np.uint8)).resize((size * scale, size * scale), Image.NEAREST)
    ImageDraw.Draw(im).text((6, 4), __import__('os').path.basename(path), fill=(255, 0, 0))
    tiles.append(im)
sheet = Image.new('RGB', (sum(t.width for t in tiles) + 8 * (len(tiles) - 1), tiles[0].height), 'white')
xo = 0
for t in tiles:
    sheet.paste(t, (xo, 0)); xo += t.width + 8
sheet.save(out)
