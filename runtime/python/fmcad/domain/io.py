"""DTO-only rules extracted from assets/cad/io.py. No SDK or filesystem access."""

_IO_IMPORTS = {'.step': 'createSTEPImportOptions', '.stp': 'createSTEPImportOptions',
               '.f3d': 'createFusionArchiveImportOptions', '.iges': 'createIGESImportOptions',
               '.igs': 'createIGESImportOptions', '.sat': 'createSATImportOptions', '.smt': 'createSMTImportOptions'}
