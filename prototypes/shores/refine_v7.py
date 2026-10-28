"""Shore prototype v7: v4's cleanup and waterline, then the step at each shore spread into a bank that keeps the shore's own trend.

usage: refine_v7.py <export.png> <out.png> --sd-from <wide_sd.py output> [--band 6] [--fit 2,8] [--sigma 4]
Each side's trend is a line fitted to its own heights 2 to 8 px from the line. The waterline crosses at the mean of the two trend
slopes. Within the band, heights blend by smoothstep from that crossing slope to the original terrain, so slopes match at both ends.
"""
import sys, json, struct, argparse
import numpy as np
from PIL import Image, PngImagePlugin
from scipy import ndimage

Image.MAX_IMAGE_PIXELS = None
ap = argparse.ArgumentParser()
ap.add_argument('src'); ap.add_argument('out')
ap.add_argument('--sd-from', required=True)
ap.add_argument('--band', type=float, default=6.0)    # px, the blend on each side
ap.add_argument('--fit', default='2,8')               # px from the line, the span each side's trend is fitted over
ap.add_argument('--sigma', type=float, default=4.0)   # px, how far along the shore the fit reaches
ap.add_argument('--lo', type=float, default=0.25)     # game m per px, the gentlest crossing
ap.add_argument('--hi', type=float, default=2.0)      # game m per px, the steepest crossing
ap.add_argument('--cross', default='mean')             # mean of the land and bed slopes, or the land's own slope
ap.add_argument('--raise-from', type=float, default=None)  # game m per px of land slope above which the band may also raise land, fully from 1 more
ap.add_argument('--step-reach', type=float, default=None)  # px, the crossing climbs the land's step at the line within this distance at least
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
sd = np.where(clean, np.minimum(sd, -0.05), np.maximum(sd, 0.05))
g = (new - plane) * k
near, far = (float(x) for x in args.fit.split(','))


def trend(ring):
    """Slope and value at the line of a line fitted to height against distance over the ring, weighted along the shore."""
    x, y = np.abs(sd), np.abs(g)
    blur = lambda a: ndimage.gaussian_filter(np.where(ring, a, 0.0), args.sigma, mode='nearest')
    s0, s1, s2, t0, t1 = blur(np.ones_like(x)), blur(x), blur(x * x), blur(y), blur(x * y)
    var = s0 * s2 - s1 * s1
    fitted = var > 0.5 * s0 * s0
    slope = np.where(fitted, (s0 * t1 - s1 * t0) / np.where(fitted, var, 1), t0 / np.maximum(s1, 1e-9))
    at_line = (t0 - slope * s1) / np.maximum(s0, 1e-9)
    return np.where(s0 > 1e-3, slope, np.nan), np.where(s0 > 1e-3, at_line, np.nan)


land_slope, land_at = trend(~clean & (sd >= near) & (sd <= far))
bed_slope, bed_at = trend(clean & (sd <= -near) & (sd >= -far))
both = np.nanmean(np.stack([land_slope, bed_slope]), 0)
cross = np.where(np.isnan(land_slope), both, land_slope) if args.cross == 'land' else both
if args.step_reach:
    # a plateau above the water is climbed at the water, which a gentle crossing would leave as a low strip with a crease behind it
    cross = np.fmax(cross, np.clip(land_at, 0, None) / args.step_reach)
cross = np.clip(cross, args.lo, args.hi)
cross = np.where(np.isnan(cross), 1.0, cross)


def blend(side):
    t = np.clip(np.abs(sd) / args.band, 0, 1)
    w = t * t * (3 - 2 * t)
    return side & (t < 1), w * g + (1 - w) * cross * sd


lip_l, land = blend(~clean)
lip_w, bed = blend(clean)
out = g.copy()
# the crossing line may lower land and raise the bed, never the reverse, so low marsh grows no berm and shallow beds no pit
out[lip_l] = np.minimum(land[lip_l], g[lip_l])
if args.raise_from is not None:
    # below a steep bank a low strip is raised to the bank's own line, where flat land would grow a berm instead
    share = np.clip(np.nan_to_num(land_slope) - args.raise_from, 0, 1)
    out[lip_l] = np.where(land[lip_l] > g[lip_l], g[lip_l] + share[lip_l] * (land[lip_l] - g[lip_l]), out[lip_l])
out[lip_w] = np.maximum(bed[lip_w], g[lip_w])
new = np.clip(plane + out / k, black, white)
q = np.round((new - black) / (white - black) * 65535).astype(np.uint16)
info = PngImagePlugin.PngInfo()
info.add_text('Description', json.dumps(meta, separators=(',', ':')))
Image.fromarray(q).save(args.out, pnginfo=info)
edge = (np.abs(sd) < 1)
print(json.dumps({'water_px': int(clean.sum()), 'mask_kept': bool(((out < 0) == clean).all()),
                  'crossing_game_m_per_px_p10_p50_p90': [round(float(x), 2) for x in np.percentile(cross[edge], [10, 50, 90])],
                  'land_step_p10_p50_p90': [round(float(x), 2) for x in np.nanpercentile(land_at[edge & ~clean], [10, 50, 90])],
                  'bed_step_p10_p50_p90': [round(float(x), 2) for x in np.nanpercentile(bed_at[edge & clean], [10, 50, 90])]}))
