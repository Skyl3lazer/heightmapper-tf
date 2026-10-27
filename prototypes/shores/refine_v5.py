"""Shore prototype v5: v4's cleanup and waterline, then land near the water capped by a bank that rises from the waterline.

usage: refine_v5.py <export.png> <out.png> --sd-from <net sd.npy> [--slope 0.4] [--curve 0.1] [--reach 8] [--soft 0.5]
The bank's height above the water at d pixels out is slope*d + curve*d^2 in-game meters.
"""
import sys, os, json, struct, argparse
import numpy as np
from PIL import Image, PngImagePlugin
from scipy import ndimage

Image.MAX_IMAGE_PIXELS = None
ap = argparse.ArgumentParser()
ap.add_argument('src'); ap.add_argument('out')
ap.add_argument('--sd-from', required=True)
ap.add_argument('--slope', type=float, default=0.4)    # game m per px at the waterline
ap.add_argument('--curve', type=float, default=0.1)    # game m per px^2, how fast the bank steepens
ap.add_argument('--reach', type=float, default=8.0)    # px past which land keeps its height
ap.add_argument('--soft', type=float, default=0.5)     # game m of rounding where the bank meets the land
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
water = h < plane
f = ndimage.gaussian_filter(water.astype(np.float64), 1.0, mode='nearest')
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

sd = np.load(args.sd_from).astype(np.float64)
# past the first pixel the distance comes from the mask's distance transform, whose steps the blur takes out
smooth = ndimage.gaussian_filter(sd, 1.0, mode='nearest')
w = np.clip(np.abs(sd) - 1, 0, 1)
dist = sd * (1 - w) + smooth * w
dist = np.where(clean, np.minimum(dist, -0.05), np.maximum(dist, 0.05))

s, c = args.slope / k, args.curve / k


def bank(d):
    return s * d + c * d * d


lip_w, lip_l = clean & (dist > -1), ~clean & (dist < 1)
new[lip_w] = plane - bank(-dist[lip_w])
new[lip_l] = plane + bank(dist[lip_l])
# land past the lip: no higher than the bank, rounded where the two meet
near = ~clean & (dist >= 1) & (dist < args.reach)
a, b = new[near], plane + bank(dist[near])
soft = args.soft / k
t = np.maximum(soft - np.abs(a - b), 0) / soft
capped = np.minimum(a, b) - t * t * soft / 4
new[near] = np.maximum(capped, np.minimum(a, plane + 0.05 / k))
# water past the lip: a bed deeper than the bank rises to it, fading back to the bed by the third pixel
band = clean & (dist <= -1) & (dist > -3)
fade = np.clip(3 + dist[band], 0, 1)
bed = new[band]
new[band] = bed + fade * (np.maximum(bed, plane - bank(-dist[band])) - bed)
new[band] = np.minimum(new[band], plane - bank(1.0))

new = np.clip(new, black, white)
q = np.round((new - black) / (white - black) * 65535).astype(np.uint16)
info = PngImagePlugin.PngInfo()
info.add_text('Description', json.dumps(meta, separators=(',', ':')))
Image.fromarray(q).save(args.out, pnginfo=info)
np.save(args.out[:-4] + '_sd.npy', np.where(np.abs(sd) < 1, sd, dist).astype(np.float32))
lowered = (h - new)[near] * k
print(json.dumps({'water_px': int(clean.sum()), 'land_px_within_reach': int(near.sum()),
                  'land_lowered_px': int((lowered > 0.05).sum()), 'lowered_game_m_p50_p90_p99': [round(float(x), 2) for x in np.percentile(lowered[lowered > 0.05], [50, 90, 99])]}))
