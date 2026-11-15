class HandlerRegistry(dict):
    def __init__(self, *args, **kwargs):
        super().__init__()


def fusion_json(value):
    return value


def fields(value):
    return value


def direction(value):
    return value


def _cad_json(value):
    return value


def _cad_fields(value):
    return value


def _cad_direction(value):
    return value


def _fixture_after_direction():
    return None


CAD_HANDLERS = {}
