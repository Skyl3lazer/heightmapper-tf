import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from scipy import ndimage
from scipy.special import ndtri
from snet import surface_net, signed_distance

N = 160
yy, xx = np.mgrid[0:N, 0:N].astype(np.float64)

def crossings(f):
    pts = []
    for ax in (1, 0):
        a = f[:, :-1] if ax else f[:-1, :]; b = f[:, 1:] if ax else f[1:, :]
        m = (a < 0) != (b < 0); t = a[m] / (a[m] - b[m]); y, x = np.nonzero(m)
        pts.append(np.stack([y, x + t], 1) if ax else np.stack([y + t, x], 1))
    return np.concatenate(pts)

def probit_sd(M, s=1.0):
    share = ndimage.gaussian_filter(M.astype(float), s, mode='nearest')
    return -s * ndtri(np.clip(share, 1e-9, 1 - 1e-9))

def snet_sd(M, **kw):
    return signed_distance(M, surface_net(M, **kw))

methods = {'probit1': lambda M: probit_sd(M), 'net L40': lambda M: snet_sd(M, iters=40),
           'net L150': lambda M: snet_sd(M, iters=150), 'net T60': lambda M: snet_sd(M, iters=60, lam=0.6, mu=-0.63)}
print('straight shore: waterline range (px) by angle')
print('angle ' + ''.join('%10s' % k for k in methods))
for a in [2, 5, 7.1, 10, 14, 22.5, 30, 35, 40]:
    th = np.radians(a); nx, ny = -np.sin(th), np.cos(th); c = N / 2
    true = (xx - c) * nx + (yy - c) * ny + 0.37
    M = true < 0
    row = []
    for k, f in methods.items():
        p = crossings(f(M)); p = p[(np.abs(p[:, 0] - c) < N / 3) & (np.abs(p[:, 1] - c) < N / 3)]
        dev = (p[:, 1] - c) * nx + (p[:, 0] - c) * ny + 0.37
        row.append(dev.max() - dev.min())
    print('%5.1f ' % a + ''.join('%10.3f' % r for r in row))
print('round lake: mean radius error / radius range (px)')
for R in [3, 6, 12, 25]:
    c = N / 2 + 0.3
    M = np.hypot(yy - c, xx - c + 0.17) < R
    row = []
    for k, f in methods.items():
        p = crossings(f(M)); r = np.hypot(p[:, 0] - c, p[:, 1] - c + 0.17)
        row.append('%+.2f/%.2f' % (r.mean() - R, r.max() - r.min()))
    print('R=%2d  ' % R + ''.join('%12s' % r for r in row))
print('square corner: distance of the waterline from the true corner point (px)')
M = (yy > 60.5) & (xx > 60.5)
for k, f in methods.items():
    p = crossings(f(M)); dd = np.hypot(p[:, 0] - 60.5, p[:, 1] - 60.5)
    print('  %-9s %.2f' % (k, dd.min()))
print('channel 2 px wide at 20 deg: crossings found (0 = channel lost)')
th = np.radians(20); nx, ny = -np.sin(th), np.cos(th)
M = np.abs((xx - N / 2) * nx + (yy - N / 2) * ny) < 1.0
for k, f in methods.items():
    print('  %-9s %d' % (k, len(crossings(f(M)))))
