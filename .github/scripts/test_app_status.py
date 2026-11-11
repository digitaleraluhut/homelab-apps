import pathlib
import tempfile
import unittest

from app_status import apps, naming_errors, table


def tree(projects: dict[str, str]) -> pathlib.Path:
    root = pathlib.Path(tempfile.mkdtemp())
    for d, name in projects.items():
        (root / "apps" / d).mkdir(parents=True)
        (root / "apps" / d / "Pulumi.yaml").write_text(
            f"name: {name}\ndescription: {d} app\nruntime:\n  name: nodejs\n"
        )
    return root


class AppsTest(unittest.TestCase):
    def test_an_app_is_a_directory_with_pulumi_yaml(self):
        root = tree({"gitea": "gitea"})
        (root / "apps" / "notes").mkdir()  # no Pulumi.yaml: not an app
        self.assertEqual(apps(root), {"gitea": {"description": "gitea app"}})

    def test_project_must_equal_directory(self):
        # The opencode incident: two apps shared project "opencode", hence one stack.
        root = tree({"opencode-router": "opencode", "opencode": "opencode"})
        self.assertEqual(
            naming_errors(root),
            ["apps/opencode-router/Pulumi.yaml: name must be 'opencode-router', is 'opencode'"],
        )

    def test_table_lists_every_app(self):
        self.assertEqual(
            table({"b": {"description": "B"}, "a": {"description": "A"}}).splitlines()[2:],
            ["| [a](./apps/a/) | A |", "| [b](./apps/b/) | B |"],
        )


if __name__ == "__main__":
    unittest.main()
