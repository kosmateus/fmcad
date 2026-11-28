class FMCAD:
    def __init__(self, context):
        self._context = context

    def call(self, operation, data):
        return self._context.call(operation, data)

    def emit(self, value):
        return value

    @property
    def has_emitted(self):
        return False

    def terminal(self):
        return None
