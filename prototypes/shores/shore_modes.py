"""Shelves at the water, along each shore normal, in game m, measured against the slope behind them.

usage: shore_modes.py <wide_sd.npy> name=export.png ...
foot: from 0.5 to 2 px out the land rises at under 60% of its slope from 2 to 6 px, which is over 1 m per px. A gentler strip at the foot of a steep bank.
step: the rise across the waterline, from 0.5 px under to 0.5 px above, is over twice the land's slope from 1 to 3 px. A face at the water with a flatter strip above it.
underwater: from 0.5 to 2 px under the water the bed falls at under 60% of its slope from 2 to 6 px, which is over 1 m per px. A shallow strip with a drop beyond it.
strip: from 0.5 to 1.5 px out the land rises by under 60% of its steepest 1 px rise between 1.5 and 4.5 px, which is over 0.5 m. A low strip at the water with a crease behind it, which a gentle crossing blended into a plateau leaves.
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


sd = np.load(sys.argv[1]).astype(np.float64)
ny, nx = np.gradient(ndimage.gaussian_filter(sd, 1.0))
norm = np.maximum(np.hypot(ny, nx), 1e-6)
ny, nx = ny / norm, nx / norm
start = (sd >= 0.5) & (sd < 1.5)
sy, sx = np.nonzero(start)
qy, qx = ny[start], nx[start]
by, bx = sy - sd[start] * qy, sx - sd[start] * qx
for name, path in (a.split('=', 1) for a in sys.argv[2:]):
    g = game(path)
    at = lambda t: ndimage.map_coordinates(g, [by + t * qy, bx + t * qx], order=1, mode='nearest')
    near, far = (at(2) - at(0.5)) / 1.5, (at(6) - at(2)) / 4
    bed_near, bed_far = (at(-0.5) - at(-2)) / 1.5, (at(-2) - at(-6)) / 4
    across, above = at(0.5) - at(-0.5), (at(3) - at(1)) / 2
    foot = (far > 1) & (near < 0.6 * far)
    step = across > 2 * np.maximum(above, 0.1)
    under = (bed_far > 1) & (bed_near < 0.6 * bed_far)
    rise = np.max([at(t + 1) - at(t) for t in (1.5, 2, 2.5, 3, 3.5)], 0)
    strip = (rise > 0.5) & (at(1.5) - at(0.5) < 0.6 * rise)
    print('%-6s foot %4.1f%%  step %4.1f%%  strip %4.1f%%  underwater %4.1f%%   median slope near/far land %.2f/%.2f, bed %.2f/%.2f' % (
        name, 100 * foot.mean(), 100 * step.mean(), 100 * strip.mean(), 100 * under.mean(), np.median(near), np.median(far), np.median(bed_near), np.median(bed_far)))
