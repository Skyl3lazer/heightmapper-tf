"""Refines the water of a heightmapper export from its own water mask, and writes a new heightmap with the same import values.

usage: refine_water.py <export.png> <out.png> [sigma] [min_water_px] [min_land_px]
"""
import sys, json, struct, zlib
import numpy as np
from PIL import Image, PngImagePlugin
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


def main():
    src, out = sys.argv[1], sys.argv[2]
    sigma = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
    min_water = int(sys.argv[4]) if len(sys.argv) > 4 else 16
    min_land = int(sys.argv[5]) if len(sys.argv) > 5 else 16
    raw, meta = read(src)
    black, white, k = meta['blackMeters'], meta['whiteMeters'], meta['heightScale']
    h = black + raw / 65535 * (white - black)
    plane = meta['waterLevel'] / k          # real meters of the game's water plane
    deepest_game = float(sys.argv[6]) if len(sys.argv) > 6 else 6.0
    smooth_ring = float(sys.argv[7]) if len(sys.argv) > 7 else 0.0
    under, over, deepest = 0.1 / k, 0.25 / k, deepest_game / k   # in-game 0.1 m under, 0.25 m over, deepest shore water

    water = h < plane
    # 1. majority smoothing of the mask
    f = ndimage.gaussian_filter(water.astype(np.float64), sigma, mode='nearest')
    clean = f >= 0.5
    # 2. size limits, 4-connected
    four = ndimage.generate_binary_structure(2, 1)
    lab, count = ndimage.label(clean, four)
    sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(count + 1))
    small_water = (sizes < min_water)[lab] & clean
    clean &= ~small_water
    lab, count = ndimage.label(~clean, four)
    sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(count + 1))
    small_land = (sizes < min_land)[lab] & ~clean
    clean |= small_land

    # 3. flipped pixels take their new side's height from around them
    def local(mask, r=2.0):
        num = ndimage.gaussian_filter(np.where(mask, h, 0.0), r, mode='nearest')
        den = ndimage.gaussian_filter(mask.astype(np.float64), r, mode='nearest')
        return np.where(den > 1e-6, num / np.maximum(den, 1e-6), np.nan)
    new = h.copy()
    to_land, to_water = water & ~clean, ~water & clean
    land_near, water_near = local(~water), local(water)
    new[to_land] = np.fmax(np.nan_to_num(land_near[to_land], nan=plane + over), plane + over)
    new[to_water] = np.fmin(np.nan_to_num(water_near[to_water], nan=plane - 0.5 / k), plane - 0.5 / k)

    fs = ndimage.gaussian_filter(clean.astype(np.float64), sigma, mode='nearest')
    if len(sys.argv) > 8 and sys.argv[8] == 'sdf':
        # 4b. signed distance in pixels to the smooth 0.5 line, positive on land: a blurred straight edge is a Gaussian CDF
        from scipy.special import ndtri
        slope = float(sys.argv[9]) / k if len(sys.argv) > 9 else 1.0 / k     # real meters per pixel of distance at the waterline
        sd = -sigma * ndtri(np.clip(fs, 1e-6, 1 - 1e-6))
        sd = np.where(clean, np.minimum(sd, -0.05), np.maximum(sd, 0.05))
        edge_w, edge_l = clean & (sd > -1), ~clean & (sd < 1)
        new[edge_w] = plane + slope * sd[edge_w]
        new[edge_l] = plane + slope * sd[edge_l]
        # the bed never rises toward the shore: at least one slope deep 1 to 2 px out, fading to the original bed by 4 px
        band = clean & (sd <= -1) & (sd > -4)
        need = slope * np.clip((4 + sd[band]) / 2, 0, 1)
        new[band] = np.minimum(new[band], plane - need)
        new = np.clip(new, black, white)
        q = np.round((new - black) / (white - black) * 65535).astype(np.uint16)
        info = PngImagePlugin.PngInfo()
        info.add_text('Description', json.dumps(meta, separators=(',', ':')))
        Image.fromarray(q).save(out, pnginfo=info)
        mask_out = out[:-4] + '_mask.png'
        Image.fromarray(np.where(clean, 255, 0).astype(np.uint8)).convert('1').save(mask_out)
        print(json.dumps({'mode': 'sdf', 'water_after': int(clean.sum()), 'water_edge_px': int(edge_w.sum()), 'land_edge_px': int(edge_l.sum()),
                          'land_edge_lowered_median_m': round(float(np.median((h[edge_l] - new[edge_l]) * k)), 2), 'deepened_px': int((new[band] < h[band] - 1e-6).sum()), 'mask': mask_out}))
        return
    # 4. antialiasing: each shore water pixel's depth puts the game's interpolated crossing where the smooth 0.5 line of f crosses
    acc, cnt = np.zeros_like(h), np.zeros_like(h)
    for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
        nb_land = np.zeros_like(clean); nb_f = np.zeros_like(fs); nb_h = np.zeros_like(h)
        ys = slice(max(0, dy), h.shape[0] + min(0, dy)); yd = slice(max(0, -dy), h.shape[0] + min(0, -dy))
        xs = slice(max(0, dx), h.shape[1] + min(0, dx)); xd = slice(max(0, -dx), h.shape[1] + min(0, -dx))
        nb_land[yd, xd] = ~clean[ys, xs]; nb_f[yd, xd] = fs[ys, xs]; nb_h[yd, xd] = new[ys, xs]
        edge = clean & nb_land & (fs > nb_f + 1e-3)
        t = np.clip((fs - 0.5) / np.maximum(fs - nb_f, 1e-3), 0.05, 0.95)
        w = (plane - t * nb_h) / (1 - t)
        acc[edge] += w[edge]; cnt[edge] += 1
    shore = cnt > 0
    ring = np.zeros_like(h)
    ring[shore] = np.clip(acc[shore] / cnt[shore], plane - deepest, plane - under)
    if smooth_ring > 0:
        # neighbors along the shore don't alternate shallow and deep
        num = ndimage.gaussian_filter(np.where(shore, ring, 0.0), smooth_ring, mode='nearest')
        den = ndimage.gaussian_filter(shore.astype(np.float64), smooth_ring, mode='nearest')
        ring[shore] = np.clip(num[shore] / den[shore], plane - deepest, plane - under)
        # the bed never rises behind the shore ring: water up to 4 px out is at least as deep as its nearest shore pixel
        dist, (iy, ix) = ndimage.distance_transform_edt(~shore, return_indices=True)
        near = clean & ~shore & (dist <= 4)
        new[near] = np.minimum(new[near], ring[iy[near], ix[near]])
    target = ring[shore]
    new[shore] = target

    new = np.clip(new, black, white)
    q = np.round((new - black) / (white - black) * 65535).astype(np.uint16)
    info = PngImagePlugin.PngInfo()
    info.add_text('Description', json.dumps(meta, separators=(',', ':')))
    Image.fromarray(q).save(out, pnginfo=info)
    mask_out = out[:-4] + '_mask.png'
    Image.fromarray(np.where(clean, 255, 0).astype(np.uint8)).convert('1').save(mask_out)
    print(json.dumps({'size': list(h.shape), 'water_before': int(water.sum()), 'water_after': int(clean.sum()),
                      'smoothing_to_land': int((water & ~(f >= 0.5)).sum()), 'smoothing_to_water': int((~water & (f >= 0.5)).sum()),
                      'small_water_removed': int(small_water.sum()), 'small_land_filled': int(small_land.sum()),
                      'shore_pixels_set': int(shore.sum()), 'shore_depth_in_game_median': round(float(np.median((plane - target) * k)), 2),
                      'mask': mask_out}))


main()
