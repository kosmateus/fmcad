"""In-memory execution of the generated inventory payload; no Fusion or file writes."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

SCRIPT = subprocess.run(
    ['node', '-e', 'process.stdout.write(require("./src/ops").buildOpScript("file_editability_list", []))'],
    cwd=Path(__file__).resolve().parents[1], check=True, capture_output=True, text=True,
).stdout


class Object:
    def __init__(self, **props):
        self.__dict__.update(props)

    def __getattr__(self, name):
        if name == 'personalUseLimits':
            raise AssertionError('must never read personalUseLimits')
        raise RuntimeError('unavailable: ' + name)


class Collection:
    def __init__(self, *items):
        self.values = items
        self.count = len(items)

    def item(self, index):
        value = self.values[index]
        if isinstance(value, Exception):
            raise value
        return value


def folder(identity='root', files=(), children=(), **props):
    return Object(id=identity, name=identity, dataFiles=Collection(*files),
                  dataFolders=Collection(*children), **props)


def project(identity='p1', name='Project', root=None):
    return Object(id=identity, name=name, rootFolder=root or folder())


class InventoryTests(unittest.TestCase):
    def report(self, projects, selector=None):
        adsk = types.ModuleType('adsk')
        adsk.core, adsk.fusion = types.ModuleType('adsk.core'), types.ModuleType('adsk.fusion')
        data = Object(dataProjects=projects)
        adsk.core.Application = Object(get=lambda: Object(data=data))
        output = io.StringIO()
        with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
            namespace = {}
            exec(compile(SCRIPT, '<inventory>', 'exec'), namespace)
            self.assertEqual(namespace['OP'], 'file_editability_list')
            namespace['ARGS'] = [] if selector is None else [selector]
            with contextlib.redirect_stdout(output):
                namespace['run']('')
        lines = output.getvalue().splitlines()
        result = json.loads(lines[0].removeprefix('FILE_EDITABILITY_LIST '))
        self.assertEqual(len(lines), 2)
        if result['complete']:
            self.assertEqual(lines[1], 'DONE')
            self.assertEqual(result['errors'], [])
        else:
            self.assertTrue(lines[1].startswith('ERROR file_editability_list '))
            self.assertNotIn('DONE', lines)
            self.assertTrue(result['errors'])
        return result

    def test_recursive_multiple_projects_and_exact_rows(self):
        child = folder('nested', files=[Object(id='f2', name='Same', isReadOnly=True)])
        root = folder(files=[Object(id='f1', name='Same', isReadOnly=False)], children=[child])
        result = self.report(Collection(project(root=root), project('p2', 'Other')))
        self.assertTrue(result['complete'])
        self.assertEqual(result['files'], [
            dict(id='f1', name='Same', projectId='p1', projectName='Project', folderId='root', folderPath='/', isReadOnly=False),
            dict(id='f2', name='Same', projectId='p1', projectName='Project', folderId='nested', folderPath='/nested', isReadOnly=True),
        ])
        self.assertEqual(result['counts'], dict(files=2, readOnly=1, notReadOnly=1, unknown=0))

    def test_selection_exact_name_or_id_and_rejection(self):
        root = folder(files=[Object(id='f', name='F', isReadOnly=False)])
        projects = Collection(project(root=root), project('p2', 'Other'))
        for selector in ['p1', 'Project']:
            self.assertEqual(len(self.report(projects, selector)['files']), 1)
        for selector in ['project', 'Pro', 'missing', '']:
            self.assertFalse(self.report(projects, selector)['complete'])
        for other in [project('p2', 'Project'), project('Project', 'Other')]:
            result = self.report(Collection(project(root=root), other), 'Project')
            self.assertEqual(result['files'], [])
            self.assertIn('ambiguous', result['errors'][0]['message'])

    def test_unknown_status_and_property_errors_preserve_rows(self):
        files = [Object(id='good', name='F', isReadOnly=False)]
        files += [Object(id=str(i), name='F', **props) for i, props in enumerate(
            [{}, {'isReadOnly': None}, {'isReadOnly': 0}])]
        files.append(Object(isReadOnly=True))
        result = self.report(Collection(project(root=folder(files=files))))
        self.assertEqual(result['counts'], dict(files=5, readOnly=1, notReadOnly=1, unknown=3))
        self.assertEqual([r['isReadOnly'] for r in result['files']], [False, None, None, None, True])
        self.assertIsNone(result['files'][-1]['id'])
        self.assertEqual({e['property'] for e in result['errors']}, {'id', 'name', 'isReadOnly'})
        self.assertTrue(all('dataFiles[' in e['scope'] for e in result['errors']))

    def test_partial_collections_and_roots_continue_siblings(self):
        good = Object(id='ok', name='OK', isReadOnly=True)
        broken = folder('broken')
        del broken.dataFiles
        root = folder(files=[RuntimeError('item failed'), None, good], children=[broken, folder('child', files=[good])])
        result = self.report(Collection(project(root=root), Object(id='p2', name='Broken'), RuntimeError('project failed'), project('p3', root=folder(files=[good]))))
        self.assertEqual(result['counts']['readOnly'], 3)
        self.assertEqual({e['property'] for e in result['errors']}, {'item', 'dataFiles', 'rootFolder'})

    def test_unknown_folder_path_and_collection_count(self):
        child = folder(files=[Object(id='f', name='F', isReadOnly=False)])
        del child.name
        child.dataFolders = Object()
        result = self.report(Collection(project(root=folder(children=[child]))))
        self.assertIsNone(result['files'][0]['folderPath'])
        self.assertEqual({e['property'] for e in result['errors']}, {'name', 'count'})

    def test_empty_hub_and_failed_project_discovery(self):
        self.assertTrue(self.report(Collection())['complete'])
        self.assertFalse(self.report(None)['complete'])
        self.assertFalse(self.report(Object())['complete'])
        result = self.report(Collection(project(), Object(id='p2')), 'p1')
        self.assertFalse(result['complete'])
        self.assertEqual(result['files'], [])
        self.assertEqual(result['errors'][-1]['property'], 'project')

    def test_invalid_collection_counts_preserve_sibling_rows_and_fail(self):
        for count in (-1, True, 1.5, '2'):
            with self.subTest(count=count):
                broken = folder('broken')
                broken.dataFiles.count = count
                good = folder('good', files=[Object(id='ok', name='OK', isReadOnly=True)])
                result = self.report(Collection(project(root=folder(children=[broken, good]))))
                self.assertFalse(result['complete'])
                self.assertEqual([row['id'] for row in result['files']], ['ok'])
                self.assertEqual(result['errors'][0]['property'], 'count')


if __name__ == '__main__':
    unittest.main()
