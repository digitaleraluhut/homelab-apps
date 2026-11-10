import pathlib
import tempfile
import unittest

from app_status import naming_errors


def tree(projects: dict[str, str]) -> pathlib.Path:
    root = pathlib.Path(tempfile.mkdtemp())
    for d, name in projects.items():
        (root / "apps" / d).mkdir(parents=True)
        (root / "apps" / d / "Pulumi.yaml").write_text(f"name: {name}\nruntime: nodejs\n")
    return root


class NamingTest(unittest.TestCase):
    def test_one_name_per_app_passes(self):
        root = tree({"gitea": "gitea"})
        apps = {"gitea": {"status": "active", "namespace": "gitea", "stack": "org/gitea/dev"}}
        self.assertEqual(naming_errors(apps, root), [])

    def test_project_must_equal_directory(self):
        # The opencode incident: two apps shared project "opencode", hence one stack.
        root = tree({"opencode-router": "opencode", "opencode": "opencode"})
        apps = {"opencode-router": {"status": "active"}, "opencode": {"status": "active"}}
        self.assertEqual(len(naming_errors(apps, root)), 1)

    def test_namespace_and_stack_must_carry_the_app_name(self):
        root = tree({"gitea": "gitea"})
        apps = {"gitea": {"status": "active", "namespace": "git", "stack": "org/other/dev"}}
        self.assertEqual(len(naming_errors(apps, root)), 2)

    def test_apps_without_pulumi_yaml_or_optional_fields_pass(self):
        root = tree({})
        (root / "apps" / "static").mkdir(parents=True)
        self.assertEqual(naming_errors({"static": {"status": "disabled"}}, root), [])


if __name__ == "__main__":
    unittest.main()
