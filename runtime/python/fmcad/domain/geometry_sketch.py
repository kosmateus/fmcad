"""Geometry sketch: domain; retained cad-v1 shared namespace."""


def _sketch_policy(data: "JsonObject") -> str:
    policy = data.get('inferencePolicy', 'explicit')
    if policy not in ('explicit', 'native'):
        raise ValueError('inferencePolicy must be explicit or native; neither changes global preferences')
    return policy
