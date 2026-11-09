import unittest

from deploy_matrix import select

APPS = {
    "gitea": {"status": "active", "namespace": "gitea", "stack": "mrsimpson/gitea/dev"},
    "wiki": {"status": "active", "namespace": "wiki"},  # legacy: own workflow, no stack
    "librechat": {"status": "active", "deploy": "manual", "stack": "mrsimpson/librechat/dev"},
    "old": {"status": "disabled", "stack": "mrsimpson/old/dev"},
}


class SelectTest(unittest.TestCase):
    def names(self, files, **kw):
        return [e["app"] for e in select(APPS, files, **kw)]

    def test_changed_active_ci_app_is_selected(self):
        self.assertEqual(self.names(["apps/gitea/index.ts"]), ["gitea"])

    def test_entry_carries_stack_and_dir(self):
        e = select(APPS, ["apps/gitea/index.ts"])[0]
        self.assertEqual(e, {"app": "gitea", "stack": "mrsimpson/gitea/dev", "dir": "apps/gitea"})

    def test_docs_md_and_vibe_changes_do_not_deploy(self):
        self.assertEqual(
            self.names(["apps/gitea/docs/a.ts", "apps/gitea/README.md", "apps/gitea/.vibe/x"]), []
        )

    def test_disabled_manual_and_stackless_apps_are_skipped(self):
        files = ["apps/old/a.ts", "apps/librechat/a.ts", "apps/wiki/a.ts"]
        self.assertEqual(self.names(files), [])

    def test_unknown_dir_ignored(self):
        self.assertEqual(self.names(["apps/nope/a.ts", "README.md"]), [])

    def test_each_app_once_sorted(self):
        apps = {**APPS, "abc": {"status": "active", "stack": "mrsimpson/abc/dev"}}
        got = [e["app"] for e in select(apps, ["apps/gitea/a", "apps/gitea/b", "apps/abc/c"])]
        self.assertEqual(got, ["abc", "gitea"])

    def test_forced_app_ignores_changed_files(self):
        self.assertEqual(self.names([], only="gitea"), ["gitea"])

    def test_forced_app_must_be_deployable(self):
        with self.assertRaises(SystemExit):
            select(APPS, [], only="wiki")
        with self.assertRaises(SystemExit):
            select(APPS, [], only="nope")


if __name__ == "__main__":
    unittest.main()
