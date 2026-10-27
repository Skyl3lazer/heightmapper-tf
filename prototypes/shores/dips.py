"""Share of open shore water whose bed rises again within 3 px farther out. usage: dips.py <png> <sd.npy>"""
import sys, json, struct, numpy as np
from PIL import Image
from scipy import ndimage
Image.MAX_IMAGE_PIXELS = None
data = open(sys.argv[1], 'rb').read(); pos = 8
while True:
    n, k = struct.unpack('>I4s', data[pos:pos + 8])
    if k == b'tEXt':
        key, _, v = data[pos + 8:pos + 8 + n].partition(b'\0')
        if key == b'Description': m = json.loads(v); break
    pos += 12 + n
raw = np.asarray(Image.open(sys.argv[1])).astype(np.float64)
g = (m['blackMeters'] + raw / 65535 * (m['whiteMeters'] - m['blackMeters'])) * m['heightScale'] - m['waterLevel']
sd = np.load(sys.argv[2]).astype(np.float64)
ny, nx = np.gradient(sd)
norm = np.maximum(np.hypot(ny, nx), 1e-6)
sel = (sd < 0) & (sd > -2.5)
yy, xx = np.nonzero(sel)
here, sdh = g[sel], sd[sel]
rise = np.zeros(len(yy)); ok = np.ones(len(yy), bool)
for step in (1, 2, 3):
    fy, fx = yy - step * ny[sel] / norm[sel], xx - step * nx[sel] / norm[sel]
    ok &= ndimage.map_coordinates(sd, [fy, fx], order=1, mode='nearest') < sdh - 0.5 * step
    rise = np.maximum(rise, ndimage.map_coordinates(g, [fy, fx], order=1, mode='nearest') - here)
r = rise[ok]
print('bed rises outward by >0.1 m: %.1f%%  >0.25 m: %.1f%%  >0.5 m: %.2f%%  p99 %.2f m' % (100 * (r > 0.1).mean(), 100 * (r > 0.25).mean(), 100 * (r > 0.5).mean(), np.percentile(r, 99)))
