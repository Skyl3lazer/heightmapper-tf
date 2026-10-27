"""Builds the normalized London export as it would be if the land lowering ran from the final shoreline.

usage: make_v6_input.py <normalized.png> <unnormalized.png> <out.png>
Land within lift/NORMALIZE_GRADE of a lowered body takes the source height less the body's lift, faded by smoothstep from the shore.
"""
import sys, json, struct
import numpy as np
from PIL import Image, PngImagePlugin
from scipy import ndimage
Image.MAX_IMAGE_PIXELS = None
GRADE, GAME_PX, MIN_ABOVE = 0.1, 4.0, 0.25

def read(p):
    data = open(p, 'rb').read(); pos = 8
    while True:
        n, k = struct.unpack('>I4s', data[pos:pos + 8])
        if k == b'tEXt':
            key, _, v = data[pos + 8:pos + 8 + n].partition(b'\0')
            if key == b'Description': m = json.loads(v); break
        pos += 12 + n
    return np.asarray(Image.open(p)).astype(np.float64), m

rb, mb = read(sys.argv[1]); rn, mn = read(sys.argv[2])
k = mb['heightScale']
to_game = lambda raw, m: (m['blackMeters'] + raw / 65535 * (m['whiteMeters'] - m['blackMeters'])) * k - m['waterLevel']
B, N = to_game(rb, mb), to_game(rn, mn)
water = B < 0
lab, count = ndimage.label(water)
wetN = ndimage.mean((N < 0).astype(float), lab, np.arange(count + 1))
lift = np.where(wetN > 0.5, 0.0, ndimage.median(N, lab, np.arange(count + 1)))
lift = np.maximum(lift, 0); lift[0] = 0
d, (iy, ix) = ndimage.distance_transform_edt(~water, return_indices=True)
near = lift[lab[iy, ix]]
fade = np.clip(1 - d * GAME_PX * GRADE / np.maximum(near, 1e-6), 0, 1)
lowered = N - near * fade * fade * (3 - 2 * fade)
land = ~water & (near > 0) & (fade > 0)
out = B.copy()
out[land] = np.maximum(np.minimum(B[land], lowered[land]), np.minimum(B[land], MIN_ABOVE))
raw = (out + mb['waterLevel']) / k
q = np.round((raw - mb['blackMeters']) / (mb['whiteMeters'] - mb['blackMeters']) * 65535).clip(0, 65535).astype(np.uint16)
info = PngImagePlugin.PngInfo(); info.add_text('Description', json.dumps(mb, separators=(',', ':')))
Image.fromarray(q).save(sys.argv[3], pnginfo=info)
ch = (B - out)[land]
print(json.dumps({'land_px_changed': int((ch > 0.05).sum()), 'lowered_game_m_p50_p90_max': [round(float(x), 2) for x in np.percentile(ch[ch > 0.05], [50, 90, 100])],
                  'water_unchanged': bool(((out < 0) == water).all())}))
