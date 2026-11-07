"""Bounded, read-only sampler regression and optional preserved-SVG benchmark.

Run with python -B; --svg is a caller-supplied preserved input.
No planner invocation, fixture writes, or performance assertions.
"""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import re
import signal
import statistics
import sys
import time
import xml.etree.ElementTree as ET

import numpy as np
from shapely.geometry import LineString

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'assets'))
import image_shared_boundaries as shared


def old_sample(segments, error):
    """Frozen _sample from 92132de (only function name/docstring changed)."""
    result = [segments[0][1][0]]
    for kind, controls in segments:
        if kind == 'L':
            result.append(controls[-1])
            continue
        stack = [(np.asarray(controls), 0)]
        while stack:
            p, depth = stack.pop()
            chord = p[-1] - p[0]
            norm = float(chord @ chord)
            t = np.clip((p - p[0]) @ chord / norm, 0, 1) if norm else np.zeros(4)
            flat = np.linalg.norm(p - p[0] - t[:, None] * chord, axis=1).max()
            if flat <= error and np.linalg.norm(chord) <= 0.25:
                result.append(p[-1].tolist())
                continue
            if depth >= 24:
                raise ValueError('Bezier sampling exceeded subdivision limit')
            q = (p[:-1] + p[1:]) / 2
            r = (q[:-1] + q[1:]) / 2
            middle = (r[0] + r[1]) / 2
            stack.append((np.array([middle, r[1], q[2], p[3]]), depth + 1))
            stack.append((np.array([p[0], q[0], r[0], middle]), depth + 1))
    return result


def bits(points):
    return np.asarray(points, dtype=np.float64).tobytes()


def compare(segments, error):
    old, new = old_sample(segments, error), shared._sample(segments, error)
    assert old == new and bits(old) == bits(new)
    assert bits([new[0], new[-1]]) == bits([segments[0][1][0], segments[-1][1][-1]])
    assert np.float64(LineString(old).length).tobytes() == np.float64(LineString(new).length).tobytes()
    return len(new)


def regression():
    families = [
        [[0., 0.], [1., 0.], [2., 0.], [3., 0.]],  # straight
        [[0., 0.], [2., 3.], [-2., 3.], [0., 0.]],  # closed
        [[0., 0.], [-3., 0.], [4., 0.], [.125, 0.]],  # overshoot
        [[0., 0.], [1., 3.], [2., -3.], [3., 0.]],
        [[-0., 0.]] * 4,
    ]
    count = points = 0
    for controls in families:
        for scale in (1e-12, .125, 1., 16.):
            for translation in ((0., 0.), (1234.125, -987.5)):
                p = (np.asarray(controls) * scale + translation).tolist()
                for error in (.005, .02):
                    chain = [('C', p), ('L', [p[-1], p[0]])]
                    for segments in (chain, shared._reverse(chain)):
                        points += compare(segments, error)
                        count += 1
    # Adjacent representable lengths and flatness values around both predicates.
    for length in (np.nextafter(.25, 0.), .25, np.nextafter(.25, 1.)):
        for height in (0., np.nextafter(.005, 0.), .005, np.nextafter(.005, 1.)):
            p = [[0., 0.], [length/3, height], [2*length/3, height], [length, 0.]]
            for segments in ([('C', p)], shared._reverse([('C', p)])):
                points += compare(segments, .005)
                count += 1
    rng = np.random.default_rng(92132)
    for _ in range(32):
        segments = [('C', rng.uniform(-4., 4., (4, 2)).tolist())]
        for chain in (segments, shared._reverse(segments)):
            points += compare(chain, .005)
            count += 1
    # Finite, positive-error failure on the first depth-first branch: no huge output.
    huge = [('C', [[0., 0.], [2.**30, 0.], [2.**31, 0.], [3*2.**30, 0.]])]
    failures = 0
    for segments in (huge, shared._reverse(huge)):
        for sampler in (old_sample, shared._sample):
            try:
                sampler(segments, .005)
            except ValueError as exc:
                assert str(exc) == 'Bezier sampling exceeded subdivision limit'
                failures += 1
            else:
                raise AssertionError('Expected depth-limit failure')
    return dict(equalCases=count, comparedPoints=points, matchedDepthFailures=failures)


def benchmark(svg, error, repeats):
    import image_trace as trace
    data = svg.read_bytes()
    before = svg.stat()
    rings = []
    for element in ET.fromstring(data):
        if element.tag.split('}')[-1] != 'path':
            continue
        current = (0, 0)
        for part in re.split(r'(?=[Mm])', element.get('d', '')):
            if not part.strip():
                continue
            prefix = f'M {current[0]} {current[1]} ' if part[0] == 'm' else ''
            raw = trace.parse_path(prefix + part)
            rings.append(trace.parse_path(prefix + part, element.get('transform', '')))
            current = raw[-1][1][-1]
    assert rings
    points = sum(compare(ring, error) for ring in rings)
    timings = {'old': [], 'new': []}
    # Alternate order to reduce systematic warmup/order bias. Equality pass warms both.
    for iteration in range(repeats):
        order = [('old', old_sample), ('new', shared._sample)]
        for name, sampler in order[::(-1 if iteration % 2 else 1)]:
            start = time.perf_counter()
            for ring in rings:
                sampler(ring, error)
            timings[name].append(time.perf_counter() - start)
    assert svg.read_bytes() == data and svg.stat().st_mtime_ns == before.st_mtime_ns
    medians = {k: statistics.median(v) for k, v in timings.items()}
    return dict(svgSha256=hashlib.sha256(data).hexdigest(), rings=len(rings),
                segments=sum(map(len, rings)), points=points, error=error,
                bitwiseEqual=True, seconds=timings, medianSeconds=medians,
                speedup=medians['old']/medians['new'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--svg', type=Path)
    parser.add_argument('--error', type=float, default=.005)
    parser.add_argument('--repeats', type=int, choices=range(1, 6), default=3)
    args = parser.parse_args()
    signal.signal(signal.SIGALRM, lambda *_: sys.exit('55-second diagnostic limit'))
    signal.alarm(55)
    report = dict(dependencies={name: importlib.metadata.version(name)
                                for name in ('numpy', 'scipy', 'shapely')})
    if args.svg:
        report['benchmark'] = benchmark(args.svg, args.error, args.repeats)
    else:
        report['regression'] = regression()
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
