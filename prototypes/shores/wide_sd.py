"""Signed distance to the surface-net waterline out to a set reach, for blends wider than the 2 px snet.signed_distance covers.

usage: wide_sd.py <export.png> <out_sd.npy> [reach px, 14]
Builds the same cleaned mask as refine_v4.py, runs the net (about 7 minutes at 4097 px), then measures every pixel within reach.
"""
import sys, os, json, struct
import numpy as np
from PIL import Image
from scipy import ndimage
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from snet import surface_net

Image.MAX_IMAGE_PIXELS = None
src, out = sys.argv[1], sys.argv[2]
reach = float(sys.argv[3]) if len(sys.argv) > 3 else 14.0
data = open(src, 'rb').read()
pos = 8
while True:
    n, k = struct.unpack('>I4s', data[pos:pos + 8])
    if k == b'tEXt':
        key, _, v = data[pos + 8:pos + 8 + n].partition(b'\0')
        if key == b'Description':
            meta = json.loads(v)
            break
    pos += 12 + n
raw = np.asarray(Image.open(src)).astype(np.float64)
h = meta['blackMeters'] + raw / 65535 * (meta['whiteMeters'] - meta['blackMeters'])
water = h < meta['waterLevel'] / meta['heightScale']
clean = ndimage.gaussian_filter(water.astype(np.float64), 1.0, mode='nearest') >= 0.5
four = ndimage.generate_binary_structure(2, 1)
for side in (True, False):
    region = clean if side else ~clean
    lab, count = ndimage.label(region, four)
    sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(count + 1))
    small = (sizes < 16)[lab] & region
    clean = clean & ~small if side else clean | small

segs = surface_net(clean, iters=100, bi=100)
H, W = clean.shape
best = np.full(clean.shape, np.inf)
y0, x0, y1, x1, ci, cj = segs.T
ci, cj = ci.astype(int), cj.astype(int)
vy, vx = y1 - y0, x1 - x0
vv = np.maximum(vy * vy + vx * vx, 1e-12)
r = int(np.ceil(reach))
for oy in range(-r, r + 2):
    for ox in range(-r, r + 2):
        py, px = ci + oy, cj + ox
        ok = (py >= 0) & (py < H) & (px >= 0) & (px < W)
        t = np.clip(((py - y0) * vy + (px - x0) * vx) / vv, 0, 1)
        dist = np.hypot(py - (y0 + t * vy), px - (x0 + t * vx))
        np.minimum.at(best, (py[ok], px[ok]), dist[ok])
far = np.where(clean, ndimage.distance_transform_edt(clean), ndimage.distance_transform_edt(~clean)) - 0.5
dist = np.where(np.isfinite(best) & (best < reach), best, np.maximum(far, reach))
np.save(out, np.where(clean, -dist, dist).astype(np.float32))
print(json.dumps({'segments': len(segs), 'reach': reach}))
