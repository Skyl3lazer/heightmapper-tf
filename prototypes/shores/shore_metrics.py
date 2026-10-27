"""Shore checks on a refined export: how far the game's waterline lands from the intended line, the bank profile, and pits.

usage: shore_metrics.py <out.png> [intended_sd.npy]
"""
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
    return np.asarray(Image.open(path)).astype(np.float64), meta


raw, m = read(sys.argv[1])
k = m['heightScale']
g = (m['blackMeters'] + raw / 65535 * (m['whiteMeters'] - m['blackMeters'])) * k - m['waterLevel']   # game m above the water plane
out = {}
if len(sys.argv) > 2:
    sd = np.load(sys.argv[2]).astype(np.float64)
    errs, stray = [], 0
    for ax in (0, 1):
        a, b = (g[:, :-1], g[:, 1:]) if ax else (g[:-1, :], g[1:, :])
        sa, sb = (sd[:, :-1], sd[:, 1:]) if ax else (sd[:-1, :], sd[1:, :])
        cross = (a < 0) != (b < 0)
        want = (sa < 0) != (sb < 0)
        stray += int((cross & ~want).sum())
        both = cross & want
        t = a[both] / (a[both] - b[both])
        ts = sa[both] / (sa[both] - sb[both])
        errs.append(t - ts)
    e = np.abs(np.concatenate(errs))
    out['crossings'] = int(e.size)
    out['waterline_error_px_p50_p90_p99'] = [round(float(x), 3) for x in np.percentile(e, [50, 90, 99])]
    out['crossings_off_the_line'] = stray
water = g < 0
dl = ndimage.distance_transform_edt(~water)
dw = ndimage.distance_transform_edt(water)
prof = {}
for d in (1, 2, 3, 4, 6):
    sel = ~water & (np.abs(dl - d) < 0.25)
    prof['land %d' % d] = [round(float(x), 2) for x in np.percentile(g[sel], [25, 50, 75])]
for d in (1, 2, 3, 4, 6):
    sel = water & (np.abs(dw - d) < 0.25)
    prof['water %d' % d] = [round(float(x), 2) for x in np.percentile(g[sel], [25, 50, 75])]
out['profile_game_m_p25_p50_p75'] = prof
# steepest rise between neighbors inside the first 3 px of land
gy, gx = np.gradient(g)
grade = np.hypot(gx, gy) / 4
for lo, hi in ((0, 1.5), (1.5, 2.5), (2.5, 3.5)):
    sel = ~water & (dl > lo) & (dl <= hi)
    out['land grade %.1f-%.1f p50/p90' % (lo, hi)] = [round(float(x), 3) for x in np.percentile(grade[sel], [50, 90])]
# a pit: shore water deeper than the water 2 px farther out by over 0.25 game m
near = water & (dw <= 3)
ny, nx = np.gradient(dw)
norm = np.maximum(np.hypot(ny, nx), 1e-6)
yy, xx = np.nonzero(near)
fy, fx = yy + 2 * ny[near] / norm[near], xx + 2 * nx[near] / norm[near]
farther = ndimage.map_coordinates(g, [fy, fx], order=1, mode='nearest')
out['pit_share_of_shore_water'] = round(float(((g[near] < farther - 0.25)).mean()), 4)
out['water_px'] = int(water.sum())
print(json.dumps(out, indent=1))
