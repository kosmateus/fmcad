"""DTO-only rules extracted from assets/cad/presentation.py. No SDK or filesystem access."""

_PRESENTATION_LIMITS = [
    'Section creation/editing requires installed SectionAnalyses API; otherwise inspect/edit are blocked.',
    'Presentation restore undoes only visibility/section/camera state, never recompute or geometry.',
    'Recompute/checkHealth is a real mutation, not a read-only inspection.',
]

def _dot_close(a: "Sequence[int | float]", b: "Sequence[int | float]") -> bool:
    return abs(sum(x * y for x, y in zip(a, b))) > 1 - 1e-9

_HEALTH_NAMES = ('HealthyFeatureHealthState', 'WarningFeatureHealthState',
                 'ErrorFeatureHealthState', 'SuppressedFeatureHealthState')
