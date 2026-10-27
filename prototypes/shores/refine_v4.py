"""Shore prototype v4: v3's cleanup, then a waterline from a constrained surface net and a land slope that meets the bank.

usage: refine_v4.py <export.png> <out.png> [--line probit|net] [--land fixed|adaptive] [--water fixed|adaptive|mirror|mirror-bed] [--sd-from net_sd.npy]
The surface net takes about 7 minutes on a 4097 px export. --sd-from reuses the _sd.npy an earlier net run saved for the same water mask.
"""
import sys, os, json, struct, argparse
import numpy as np
from PIL import Image, PngImagePlugin
from scipy import ndimage
from scipy.special import ndtri
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from snet import surface_net, signed_distance

Image.MAX_IMAGE_PIXELS = None
ap = argparse.ArgumentParser()
ap.add_argument('src'); ap.add_argument('out')
ap.add_argument('--line', default='net'); ap.add_argument('--land', default='adaptive'); ap.add_argument('--water', default='fixed')
ap.add_argument('--slope', type=float, default=1.0)        # game m per px at the waterline on the water side
ap.add_argument('--land-lo', type=float, default=0.5)      # game m per px, the gentlest land slope
ap.add_argument('--land-hi', type=float, default=3.0)      # game m per px, the steepest land slope
ap.add_argument('--water-hi', type=float, default=1.5)
ap.add_argument('--along', type=float, default=2.0)        # px of smoothing of the slope along the shore
ap.add_argument('--sd-from', default=None)
ap.add_argument('--reach', type=float, default=4.0)        # px of water the shelf may span before the bed takes over
ap.add_argument('--ring', type=float, default=2.5)        # px, the far edge of the land ring the slope is read from
ap.add_argument('--iters', type=int, default=100); ap.add_argument('--bi', type=int, default=100)
args = ap.parse_args()


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


raw, meta = read(args.src)
black, white, k = meta['blackMeters'], meta['whiteMeters'], meta['heightScale']
h = black + raw / 65535 * (white - black)
plane = meta['waterLevel'] / k
sigma = 1.0
water = h < plane
f = ndimage.gaussian_filter(water.astype(np.float64), sigma, mode='nearest')
clean = f >= 0.5
four = ndimage.generate_binary_structure(2, 1)
for side in (True, False):
    region = clean if side else ~clean
    lab, count = ndimage.label(region, four)
    sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(count + 1))
    small = (sizes < 16)[lab] & region
    clean = clean & ~small if side else clean | small


def local(mask, r=2.0):
    num = ndimage.gaussian_filter(np.where(mask, h, 0.0), r, mode='nearest')
    den = ndimage.gaussian_filter(mask.astype(np.float64), r, mode='nearest')
    return np.where(den > 1e-6, num / np.maximum(den, 1e-6), np.nan)


new = h.copy()
to_land, to_water = water & ~clean, ~water & clean
new[to_land] = np.fmax(np.nan_to_num(local(~water)[to_land], nan=plane + 0.25 / k), plane + 0.25 / k)
new[to_water] = np.fmin(np.nan_to_num(local(water)[to_water], nan=plane - 0.5 / k), plane - 0.5 / k)

if args.sd_from:
    sd = np.load(args.sd_from).astype(np.float64)
elif args.line == 'net':
    sd = signed_distance(clean, surface_net(clean, iters=args.iters, bi=args.bi))
else:
    fs = ndimage.gaussian_filter(clean.astype(np.float64), sigma, mode='nearest')
    sd = -sigma * ndtri(np.clip(fs, 1e-6, 1 - 1e-6))
sd = np.where(clean, np.minimum(sd, -0.05), np.maximum(sd, 0.05))


def along(values, ring, at):
    """Slope from the ring around the shore, averaged along it and read at the lip pixels."""
    num = ndimage.gaussian_filter(np.where(ring, values, 0.0), args.along, mode='nearest')
    den = ndimage.gaussian_filter(np.where(ring, np.abs(sd), 0.0), args.along, mode='nearest')
    return np.where(den > 1e-6, num / np.maximum(den, 1e-6), np.nan)[at]


edge_w, edge_l = clean & (sd > -1), ~clean & (sd < 1)
sw = np.full(edge_w.sum(), args.slope / k)
sl = np.full(edge_l.sum(), args.slope / k)
if args.land == 'adaptive':
    ring = ~clean & (sd >= 1) & (sd < args.ring)
    sl = np.clip(np.nan_to_num(along(new - plane, ring, edge_l), nan=args.slope / k), args.land_lo / k, args.land_hi / k)
if args.water in ('mirror', 'mirror-bed'):
    # one slope across the waterline, read from the land side, keeps the game's crossing on the line
    ring = ~clean & (sd >= 1) & (sd < args.ring)
    lip = edge_w | edge_l
    s_all = np.clip(np.nan_to_num(along(new - plane, ring, lip), nan=args.slope / k), args.land_lo / k, args.land_hi / k)
    if args.water == 'mirror-bed':
        # no deeper than the bed gets within reach, so the shelf it leaves meets the bed without a dip
        reach = args.reach
        bed = np.where(clean & (sd <= -1) & (sd > -reach), plane - new, 0.0)
        deepest = ndimage.maximum_filter(bed, size=int(2 * reach + 1), mode='nearest')[lip]
        s_all = np.minimum(s_all, np.maximum(deepest, 0.25 / k))
    s_map = np.zeros_like(new); s_map[lip] = s_all
    sw, sl = s_map[edge_w], s_map[edge_l]
    # the bed behind the lip takes the nearest lip slope
    dist, (iy, ix) = ndimage.distance_transform_edt(~edge_w, return_indices=True)
    s_bed = s_map[iy, ix]
elif args.water == 'adaptive':
    ring = clean & (sd <= -1) & (sd > -2.5)
    sw = np.clip(np.nan_to_num(along(plane - new, ring, edge_w), nan=args.slope / k), args.land_lo / k, args.water_hi / k)
new[edge_w] = plane + sw * sd[edge_w]
new[edge_l] = plane + sl * sd[edge_l]
band = clean & (sd <= -1) & (sd > -4)
if args.water == 'mirror-bed':
    band = clean & (sd <= -1) & (sd > -args.reach)
    need = s_bed[band] * np.clip(args.reach + sd[band], 0, 1)
else:
    need = (s_bed[band] if args.water == 'mirror' else args.slope / k) * np.clip((4 + sd[band]) / 2, 0, 1)
new[band] = np.minimum(new[band], plane - need)
new = np.clip(new, black, white)
q = np.round((new - black) / (white - black) * 65535).astype(np.uint16)
info = PngImagePlugin.PngInfo()
info.add_text('Description', json.dumps(meta, separators=(',', ':')))
Image.fromarray(q).save(args.out, pnginfo=info)
np.save(args.out[:-4] + '_sd.npy', sd.astype(np.float32))
print(json.dumps({'line': args.line, 'land': args.land, 'water': args.water, 'water_px': int(clean.sum()),
                  'land_slope_game_p10_p50_p90': [round(float(x) * k, 2) for x in np.percentile(sl, [10, 50, 90])],
                  'water_slope_game_p50': round(float(np.median(sw)) * k, 2)}))
