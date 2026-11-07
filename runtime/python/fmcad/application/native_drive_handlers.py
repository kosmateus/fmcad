"""Isolated handler descriptor for native drive experiments and MotionLinks."""

if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'native-drive'

CAD_HANDLERS.update({'mechanism.drive-test': mechanism_drive_test,
                     'mechanism.motion-link.create': mechanism_motion_link_create})
