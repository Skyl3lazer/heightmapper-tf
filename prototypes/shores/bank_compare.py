"""Land height above its own water, by distance from the shore, for exports of the same box.

usage: bank_compare.py <unnormalized.png> <shoreline.png> <name=export.png>...
The unnormalized export gives each water body's source surface. The shoreline export sets which pixels are water.
"""
import sys, json, struct
import numpy as np
from PIL import Image
from scipy import ndimage

Image.MAX_IMAGE_PIXELS = None


def game(path):
    data = open(path, 'rb').read()
    pos = 8
    while True:
        n, k = struct.unpack('>I4s', data[pos:pos + 8])
        if k == b'tEXt':
            key, _, v = data[pos + 8:pos + 8 + n].partition(b'\0')
            if key == b'Description':
                m = json.loads(v)
                break
        pos += 12 + n
    raw = np.asarray(Image.open(path)).astype(np.float64)
    return (m['blackMeters'] + raw / 65535 * (m['whiteMeters'] - m['blackMeters'])) * m['heightScale'] - m['waterLevel']


N = game(sys.argv[1])
water = game(sys.argv[2]) < 0
runs = {name: game(path) for name, path in (a.split('=', 1) for a in sys.argv[3:])}
lab, count = ndimage.label(water)
# a body that is water in the unnormalized export sits at its level, anything else at its own flat surface
wet = ndimage.mean((N < 0).astype(float), lab, np.arange(count + 1))
surface = np.where(wet > 0.5, 0.0, ndimage.median(N, lab, np.arange(count + 1)))
dist, (iy, ix) = ndimage.distance_transform_edt(~water, return_indices=True)
natural = N - surface[lab[iy, ix]]
print('game m above the water, p25/p50/p75 (p75 - p25)')
for d in (1, 2, 3, 4, 6, 8):
    sel = ~water & (np.abs(dist - d) < 0.25)
    row = ['source %s' % '/'.join('%.2f' % x for x in np.percentile(natural[sel], [25, 50, 75]))]
    for name, g in runs.items():
        a, b, c = np.percentile(g[sel], [25, 50, 75])
        row.append('%s %.2f/%.2f/%.2f (%.2f)' % (name, a, b, c, c - a))
    print('  %d px  %s' % (d, '   '.join(row)))
