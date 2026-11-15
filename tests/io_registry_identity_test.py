"""Compatibility table and direct registration share the actual runtime callables."""
import sys
import unittest
from unittest.mock import Mock, patch

from python_document_io_test import ROOT, fake_sdk, family_source, load_legacy_core


class IORegistryIdentityTests(unittest.TestCase):
    def test_data_import_table_preserves_handler_identity_and_order(self):
        namespace = {}
        with patch.dict(sys.modules, fake_sdk()):
            load_legacy_core(namespace, ROOT)
            exec(compile(family_source('data_import'), '<canonical-data-import>', 'exec'), namespace)
        table = namespace['_DI_HANDLERS']
        registry = namespace['CAD_HANDLERS']
        self.assertEqual([key for key in registry if key in table], list(table))
        for operation, handler in table.items():
            with self.subTest(operation=operation):
                self.assertIs(handler, registry[operation])
                self.assertIs(handler, namespace['_di_handler'])

    def test_table_preserves_order_identity_and_late_dispatch(self):
        namespace = {}
        with patch.dict(sys.modules, fake_sdk()):
            load_legacy_core(namespace, ROOT)
            exec(compile(family_source('io'), '<canonical-io>', 'exec'), namespace)
        table = namespace['_IO_HANDLERS']
        registry = namespace['CAD_HANDLERS']
        self.assertEqual([key for key in registry if key in table], list(table))
        for operation, handler in table.items():
            with self.subTest(operation=operation):
                self.assertIs(handler, registry[operation])
        execute = Mock(return_value={'result': True})
        ctx, data = object(), {'visibility': 'fixture'}
        with patch.dict(namespace, {'_io_visibility': execute}):
            self.assertEqual(table['visibility.show'](ctx, data), {'result': True})
            execute.assert_called_once_with(ctx, data, 'show')
            self.assertEqual(table['visibility.show'](c=ctx, d=data), {'result': True})
        self.assertEqual(table['visibility.show'].__name__, '<lambda>')


if __name__ == '__main__':
    unittest.main()
