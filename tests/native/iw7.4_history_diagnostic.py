"""Read-only diagnostic for actual Fusion TimelineGroup health enum values."""
import adsk.fusion

DOC_NAME = 'Scratch'
ARGS = {}


def run(_context):
    identity = FMCAD.call('document.status', {})
    if identity.get('fileId') != ARGS.get('fileId') or identity.get('projectId') != ARGS.get('projectId') or \
            identity.get('folderId') != ARGS.get('folderId'):
        raise RuntimeError('History diagnostic scratch identity differs from assigned IDs')
    timeline = FMCAD.design.timeline
    group = timeline.timelineGroups.item(0)
    children = []
    for index in range(group.count):
        item = group.item(index)
        state = getattr(item, 'healthState', None)
        children.append({'index': index, 'name': getattr(item, 'name', None),
                         'objectType': getattr(item, 'objectType', None),
                         'healthState': int(state) if state is not None else None})
    enums = {}
    for name in dir(adsk.fusion):
        if 'health' not in name.lower() and 'timeline' not in name.lower():
            continue
        try:
            value = getattr(adsk.fusion, name)
            if isinstance(value, type):
                members = {}
                for member_name in dir(value):
                    try:
                        member_value = getattr(value, member_name)
                        if isinstance(member_value, int):
                            members[member_name] = int(member_value)
                    except Exception:
                        pass
                enums[name] = members
        except Exception:
            pass
    return {'groupName': group.name, 'groupType': getattr(group, 'objectType', None),
            'groupHealthState': int(group.healthState), 'groupCount': group.count,
            'children': children, 'enumMembers': enums}
