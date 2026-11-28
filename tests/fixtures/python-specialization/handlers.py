events = []


def make_literal_handler(mode):
    def handler(data):
        if mode == "known":
            events.append("literal:known")
            print("literal:known")
            return "known"
        events.append("literal:other")
        print("literal:other")
        return "other"

    return handler


UNKNOWN_MODE = "other"


def make_unknown_handler(mode):
    def handler(data):
        if mode == "known":
            events.append("unknown:known")
            print("unknown:known")
            return "known"
        events.append("unknown:other")
        print("unknown:other")
        return "other"

    return handler


def make_multi_handler(mode):
    def handler(data):
        if mode == "left":
            events.append("multi:left")
            print("multi:left")
            return "left"
        if mode == "right":
            events.append("multi:right")
            print("multi:right")
            return "right"
        return "unexpected"

    return handler


def default_value():
    events.append("default")
    print("default effect")
    return "default"


def decorate(handler):
    events.append("decorator")
    print("decorator effect")

    def wrapped(*args, **kwargs):
        events.append("wrapper")
        return handler(*args, **kwargs)

    return wrapped


def predecessor():
    return "captured predecessor"


captured_predecessor = predecessor


def predecessor():
    return "replacement predecessor"


@decorate
def effects_handler(value=default_value()):
    return captured_predecessor(), value


marker = "global marker"


def make_unbound_handler(mode):
    def handler(data):
        if mode == "active":
            pass
        if False:
            marker = "unreachable local assignment"
        return marker

    return handler


def make_generator_handler(mode):
    def handler(data):
        if mode == "active":
            return "generator return value"
        if False:
            yield "unreachable yield"

    return handler


identity_sentinel = "".join(("same value", " with distinct identity"))
identity_literal = "same value with distinct identity"
assert identity_literal == identity_sentinel and identity_literal is not identity_sentinel


def make_identity_handler(value):
    def handler(data):
        if value is identity_sentinel:
            return "same object"
        return "distinct object"

    return handler


# Multibyte text before the selected functions exercises UTF-8 source spans.
unicode_note = "przed zmianą: żółć 🧪 λ"


def unused_unicode_definition():
    return "nieużywana 🌻"


def make_unicode_handler(mode):
    def handler(data):
        if mode == "kept":
            events.append("unicode:kept")
            print("wynik 🌻 — zachowany")
            return "zachowany 🧩"
        events.append("unicode:other")
        return "inny"

    return handler


class ReflectiveReceiver:
    def hidden(self):
        return "reflected method"

    def visible(self):
        return "visible method"


reflective_receiver = ReflectiveReceiver()
reflective_alias = reflective_receiver


def reflection_handler(data):
    return getattr(reflective_alias, data["method"])()


class SubclassBase:
    def dispatch(self):
        return self.kind()

    def kind(self):
        return "base"


class SubclassReceiver(SubclassBase):
    def kind(self):
        return "subclass override"


subclass_receiver = SubclassReceiver()


def subclass_handler(data):
    return subclass_receiver.dispatch()


class UnknownReceiver:
    def target(self):
        return "unknown receiver method"

    def unrelated(self):
        return "unrelated method"


def unknown_receiver_handler(data):
    return unknown_receiver_callback(UnknownReceiver()).target()


def right_side_effect():
    events.append("short-circuit right side")
    print("short-circuit right side")
    return True


def short_and_handler(data):
    if data.get("enabled") and right_side_effect():
        return "and taken"
    return "and skipped"


def short_or_handler(data):
    if data.get("enabled") or right_side_effect():
        return "or taken"
    return "or skipped"


CAD_HANDLERS.update(
    {
        "fixture.literal": make_literal_handler("known"),
        "fixture.unknown": make_unknown_handler(UNKNOWN_MODE),
        "fixture.left": make_multi_handler("left"),
        "fixture.right": make_multi_handler("right"),
        "fixture.effects": effects_handler,
        "fixture.unbound": make_unbound_handler("active"),
        "fixture.generator": make_generator_handler("active"),
        "fixture.identity": make_identity_handler(identity_literal),
        "fixture.unicode": make_unicode_handler("kept"),
        "fixture.reflection": reflection_handler,
        "fixture.subclass": subclass_handler,
        "fixture.unknown_receiver": unknown_receiver_handler,
        "fixture.short_and": short_and_handler,
        "fixture.short_or": short_or_handler,
    }
)
