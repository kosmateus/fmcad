"""Runtime regression coverage for feature contracts used only by the checker."""
import unittest

import feature_rework_test as feature_rework


TYPE_ONLY_CONTRACTS = (
    '_FeatureExtrude',
    '_FeatureNativePlan',
    '_FeatureOperationPlan',
    '_FeatureRename',
    '_FeatureExpression',
    '_FeatureToEntityExtent',
    '_FeatureMutableTimeline',
    '_FeatureOccurrenceMatrix',
)


class FeatureTypingSeamTests(unittest.TestCase):
    def test_inspect_and_edit_keep_working_without_runtime_type_contracts(self):
        for name in TYPE_ONLY_CONTRACTS:
            self.assertFalse(name in feature_rework.namespace, f'{name} is runtime-bound')

        fixture = feature_rework.FeatureReworkTests()
        fixture.setUp()
        feature = feature_rework.make_extrude(fixture.ctx)
        distance = feature_rework.Parameter('d12', '5 mm', 'cm', 0.5)
        feature.extentOne = feature_rework.DistanceExtentDefinition(distance)

        inspected = fixture.call(
            'feature.inspect',
            {'schemaVersion': 1, 'frame': 'component', 'feature': 'Extrude1'},
        )
        self.assertEqual(inspected['extent']['mode'], 'distance')

        fixture.call(
            'feature.edit',
            {
                'schemaVersion': 1,
                'frame': 'component',
                'feature': 'Extrude1',
                'name': 'Renamed',
                'entries': [{'name': 'd12', 'role': 'distance', 'expression': '6 mm'}],
            },
        )
        self.assertEqual(feature.name, 'Renamed')
        self.assertEqual(distance.expression, '6 mm')


if __name__ == '__main__':
    unittest.main()
