"""Constrained 2D surface net over a water mask, and the signed distance to it (positive on land, in pixels)."""
import numpy as np
from scipy import ndimage


def surface_net(M, iters=40, lam=0.5, mu=None, eps=0.02, bi=0, bilam=0.2):
    """Vertex per mixed 2x2 cell, relaxed toward its contour neighbors and clamped inside its cell."""
    a, b, c, d = M[:-1, :-1], M[:-1, 1:], M[1:, :-1], M[1:, 1:]
    top, bot, lef, rig = a != b, c != d, a != c, b != d
    mixed = top | bot | lef | rig
    I, J = np.mgrid[0:M.shape[0] - 1, 0:M.shape[1] - 1].astype(np.float64)
    t, b, l, r = (e.astype(np.float64) for e in (top, bot, lef, rig))
    n = t + b + l + r
    Y = np.where(mixed, (t * I + b * (I + 1) + (l + r) * (I + 0.5)) / np.maximum(n, 1), I + 0.5)
    X = np.where(mixed, ((t + b) * (J + 0.5) + l * J + r * (J + 1)) / np.maximum(n, 1), J + 0.5)

    def avg(Y, X):
        sy, sx, cnt = np.zeros_like(Y), np.zeros_like(X), np.zeros_like(Y)
        # right neighbor shares the right edge, bottom neighbor the bottom edge
        sy[:, :-1] += np.where(rig[:, :-1], Y[:, 1:], 0); sx[:, :-1] += np.where(rig[:, :-1], X[:, 1:], 0); cnt[:, :-1] += rig[:, :-1]
        sy[:, 1:] += np.where(lef[:, 1:], Y[:, :-1], 0); sx[:, 1:] += np.where(lef[:, 1:], X[:, :-1], 0); cnt[:, 1:] += lef[:, 1:]
        sy[:-1, :] += np.where(bot[:-1, :], Y[1:, :], 0); sx[:-1, :] += np.where(bot[:-1, :], X[1:, :], 0); cnt[:-1, :] += bot[:-1, :]
        sy[1:, :] += np.where(top[1:, :], Y[:-1, :], 0); sx[1:, :] += np.where(top[1:, :], X[:-1, :], 0); cnt[1:, :] += top[1:, :]
        ok = mixed & (cnt > 0)
        return np.where(ok, sy / np.maximum(cnt, 1), Y), np.where(ok, sx / np.maximum(cnt, 1), X)

    def clamp(Y, X):
        return np.clip(Y, I + eps, I + 1 - eps), np.clip(X, J + eps, J + 1 - eps)

    for _ in range(iters):
        ay, ax = avg(Y, X)
        Y, X = clamp(Y + lam * (ay - Y), X + lam * (ax - X))
        if mu is not None:
            ay, ax = avg(Y, X)
            Y, X = clamp(Y + mu * (ay - Y), X + mu * (ax - X))
    for _ in range(bi):
        ay, ax = avg(Y, X)
        ly, lx = ay - Y, ax - X
        by, bx = avg(ly, lx)   # neighbors' Laplacian, averaged
        Y, X = clamp(Y - bilam * (by - ly), X - bilam * (bx - lx))
    # segments to the right and bottom neighbors
    segs = []
    for m, (dy, dx) in ((rig[:, :-1], (0, 1)), (bot[:-1, :], (1, 0))):
        ii, jj = np.nonzero(m)
        segs.append(np.stack([Y[ii, jj], X[ii, jj], Y[ii + dy, jj + dx], X[ii + dy, jj + dx], ii, jj], 1))
    return np.concatenate(segs)


def signed_distance(M, segs, reach=4.5):
    """Distance from each pixel center to the nearest segment within 2 px, else from the mask's distance transform."""
    H, W = M.shape
    best = np.full(M.shape, np.inf)
    y0, x0, y1, x1, ci, cj = segs.T
    ci, cj = ci.astype(int), cj.astype(int)
    for oy in range(-1, 3):
        for ox in range(-1, 4):
            py, px = ci + oy, cj + ox
            ok = (py >= 0) & (py < H) & (px >= 0) & (px < W)
            vy, vx = y1 - y0, x1 - x0
            t = np.clip(((py - y0) * vy + (px - x0) * vx) / np.maximum(vy * vy + vx * vx, 1e-12), 0, 1)
            dist = np.hypot(py - (y0 + t * vy), px - (x0 + t * vx))
            np.minimum.at(best, (py[ok], px[ok]), dist[ok])
    far = np.where(M, ndimage.distance_transform_edt(M), ndimage.distance_transform_edt(~M)) - 0.5
    dist = np.where(np.isfinite(best) & (best < 2), best, far)
    return np.where(M, -dist, dist)
