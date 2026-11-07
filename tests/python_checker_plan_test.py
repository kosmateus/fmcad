"""Class witnesses must retain full analysis of every referenced runtime body."""
import json
from pathlib import Path
import subprocess
import sys
import unittest
from typing import cast


HELPER = Path(__file__).resolve().parents[1] / 'runtime/python/typing/checker-project.py'


def plan(source: str, role: str = 'runtime') -> dict[str, object]:
    units = [
        {'id': 'types', 'filename': 'types.py', 'role': 'runtime', 'source':
         'class Box: pass\nclass Document: pass\nclass AlphaBeta: pass\nclass Bryła: pass\n'},
        {'id': 'use', 'filename': 'use.py', 'role': role, 'source': source},
    ]
    result = subprocess.run(
        [sys.executable, '-I', '-S', str(HELPER)],
        input=json.dumps({'units': [], 'sourceUnits': units}), text=True,
        capture_output=True, check=True, timeout=10,
    )
    response = cast(dict[str, object], json.loads(result.stdout))
    return cast(dict[str, object], response['analysisPlan'])


class ClassWitnessTests(unittest.TestCase):
    def test_names_and_forward_annotations_retain_their_use_body(self) -> None:
        result = plan('def use(value: "Document") -> "Box":\n    return Box()\n')
        self.assertEqual(result['classUseWitnesses'], {
            'Box': 'use:1:0:use', 'Document': 'use:1:0:use',
        })

    def test_literal_boundaries_do_not_create_false_class_uses(self) -> None:
        result = plan('def use() -> tuple[str, ...]:\n'
                      '    return "Alpha", "Beta", "Boxed", "_Box", "Box_", "xDocument", "Bryłax"\n')
        self.assertEqual(result['classUseWitnesses'], {})

    def test_punctuation_and_unicode_identifiers_keep_word_boundaries(self) -> None:
        result = plan('def use() -> str:\n    return "tuple[Box, Bryła]"\n')
        self.assertEqual(result['classUseWitnesses'], {
            'Box': 'use:1:0:use', 'Bryła': 'use:1:0:use',
        })

    def test_preserved_user_body_is_not_a_projected_runtime_witness(self) -> None:
        result = plan('def use() -> "Box":\n    return Box()\n', role='user')
        self.assertEqual(result['classUseWitnesses'], {})

    def test_smallest_complete_use_body_wins_and_plan_hash_is_stable(self) -> None:
        source = ('def large() -> "Box":\n    a = Box()\n    print(a)\n    return a\n'
                  'def small() -> "Box":\n    return Box()\n')
        first = plan(source)
        self.assertEqual(first['classUseWitnesses'], {'Box': 'use:5:0:small'})
        self.assertEqual(first, plan(source))


if __name__ == '__main__':
    unittest.main()
