"""How far the shapeShores waterline wanders from a true straight shore, by angle and blur."""
import numpy as np
from scipy import ndimage
from scipy.special import ndtri

N = 240
yy, xx = np.mgrid[0:N, 0:N].astype(np.float64)

def crossings(f):
    pts = []
    a, b = f[:, :-1], f[:, 1:]
    m = (a < 0) != (b < 0)
    t = a[m] / (a[m] - b[m]); y, x = np.nonzero(m)
    pts.append(np.stack([y, x + t], 1))
    a, b = f[:-1, :], f[1:, :]
    m = (a < 0) != (b < 0)
    t = a[m] / (a[m] - b[m]); y, x = np.nonzero(m)
    pts.append(np.stack([y + t, x], 1))
    return np.concatenate(pts)

def run(theta_deg, sigma, offset=0.37):
    th = np.radians(theta_deg)
    nx, ny = -np.sin(th), np.cos(th)
    c = N / 2
    true = (xx - c) * nx + (yy - c) * ny + offset   # positive on land
    mask = (true < 0).astype(np.float64)              # water
    share = ndimage.gaussian_filter(mask, sigma, mode='nearest')
    sd = -sigma * ndtri(np.clip(share, 1e-9, 1 - 1e-9))
    p = crossings(sd)
    inner = (np.abs(p[:, 0] - c) < N / 3) & (np.abs(p[:, 1] - c) < N / 3)
    p = p[inner]
    dev = (p[:, 1] - c) * nx + (p[:, 0] - c) * ny + offset
    return dev.max() - dev.min(), dev.std()

print('angle   ' + '   '.join('sigma %.1f range/std' % s for s in (1.0, 1.5, 2.0)))
for a in [0, 2, 5, 7.1, 10, 14, 18.4, 22.5, 26.6, 30, 35, 40, 45]:
    print('%5.1f  ' % a + '   '.join('%6.3f / %5.3f px    ' % run(a, s) for s in (1.0, 1.5, 2.0)))
