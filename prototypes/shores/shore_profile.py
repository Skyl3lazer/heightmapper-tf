"""Height above the water plane, in game meters, by distance from the waterline. usage: shore_profile.py <export.png> [base.png]"""
import sys, json, struct
import numpy as np
from PIL import Image
from scipy import ndimage
Image.MAX_IMAGE_PIXELS = None

def read(path):
    data = open(path, 'rb').read()
    pos, meta = 8, None
    while pos < len(data):
        n, k = struct.unpack('>I4s', data[pos:pos + 8])
        if k == b'tEXt':
            key, _, v = data[pos + 8:pos + 8 + n].partition(b'\0')
            if key == b'Description':
                meta = json.loads(v)
        if k == b'IDAT':
            break
        pos += 12 + n
    raw = np.asarray(Image.open(path)).astype(np.float64)
    return raw, meta

def game(path):
    raw, m = read(path)
    lo, hi = m['minHeight'] if 'minHeight' in m else None, None
    k = m['heightScale']
    h = (m['blackMeters'] + raw / 65535 * (m['whiteMeters'] - m['blackMeters'])) * k
    return h, m['waterLevel'], m

h, level, m = game(sys.argv[1])
water = h < level
dl = ndimage.distance_transform_edt(~water)   # land: px to nearest water pixel center
dw = ndimage.distance_transform_edt(water)
print('level', level, 'k', m['heightScale'], 'size', h.shape)
rows = []
for d in [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20]:
    sel = (~water) & (np.abs(dl - d) < 0.25)
    if sel.sum() < 50: continue
    v = h[sel] - level
    rows.append((d, int(sel.sum()), *np.percentile(v, [10, 25, 50, 75, 90]).round(2)))
print('land  dist   n     p10   p25   p50   p75   p90 (game m above level)')
for r in rows: print('     %5.1f %7d ' % r[:2] + ' '.join('%5.2f' % x for x in r[2:]))
for d in [1, 2, 3, 4, 6]:
    sel = water & (np.abs(dw - d) < 0.25)
    v = h[sel] - level
    print('water %4.1f %7d ' % (d, sel.sum()) + ' '.join('%5.2f' % x for x in np.percentile(v, [10, 25, 50, 75, 90])))
# steepest step on land near water: max height difference to a 4-neighbor, per distance band
gy, gx = np.gradient(h)
g = np.hypot(gx, gy) / 4  # rise over run, 4 m per px
for lo_, hi_ in [(0, 1.5), (1.5, 2.5), (2.5, 3.5), (3.5, 5), (5, 8), (8, 20), (20, 1e9)]:
    sel = (~water) & (dl > lo_) & (dl <= hi_)
    print('land grade %4.1f-%-5g n=%8d  p50 %.3f p90 %.3f p99 %.3f' % (lo_, hi_, sel.sum(), *np.percentile(g[sel], [50, 90, 99])))
