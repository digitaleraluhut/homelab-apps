import json
import os
import pathlib
import shutil
import tempfile
import textwrap
import unittest

import data_loss
from data_loss import Finding, approved, changed_apps, check, compare, comment_body

ROOT = pathlib.Path(__file__).resolve().parents[2]
HAS_NODE_MODULES = (ROOT / "node_modules" / "@pulumi" / "pulumi").is_dir()


def res(type_, name, inputs=None, parent=""):
    """A rendered resource as render_app.cjs emits it."""
    qualified = f"{parent}${type_}" if parent else type_
    return {"urn": f"urn:pulumi:dev::demo::{qualified}::{name}", "type": type_, "name": name, "inputs": inputs or {}}


PVC = "kubernetes:core/v1:PersistentVolumeClaim"
NS = "kubernetes:core/v1:Namespace"
DEPLOY = "kubernetes:apps/v1:Deployment"
STS = "kubernetes:apps/v1:StatefulSet"
SVC = "kubernetes:core/v1:Service"
RELEASE = "kubernetes:helm.sh/v3:Release"
CNPG = "kubernetes:postgresql.cnpg.io/v1:Cluster"
LONGHORN = "kubernetes:longhorn.io/v1beta2:Volume"


def pvc(name="data", storage_class="longhorn-persistent", size="1Gi"):
    return res(
        PVC,
        name,
        {
            "metadata": {"name": name, "namespace": "demo"},
            "spec": {
                "accessModes": ["ReadWriteOnce"],
                "storageClassName": storage_class,
                "resources": {"requests": {"storage": size}},
            },
        },
    )


def deploy(image="nginx:1"):
    return res(DEPLOY, "demo", {"metadata": {"name": "demo", "namespace": "demo"}, "spec": {"image": image}})


class CompareTest(unittest.TestCase):
    """Which differences between two renders of one app count as data loss."""

    def kinds(self, base, head):
        return [(f.kind, f.resource) for f in compare("demo", base, head)]

    def test_removed_pvc_is_data_loss(self):
        self.assertEqual(self.kinds([pvc(), deploy()], [deploy()]), [("deleted", f"{PVC}::data")])

    def test_image_only_change_is_not(self):
        self.assertEqual(self.kinds([pvc(), deploy("nginx:1")], [pvc(), deploy("nginx:2")]), [])

    def test_growing_a_pvc_is_not(self):
        self.assertEqual(self.kinds([pvc(size="1Gi")], [pvc(size="2Gi")]), [])

    def test_pvc_storage_class_change_replaces_it(self):
        got = compare("demo", [pvc()], [pvc(storage_class="longhorn-uncritical")])
        self.assertEqual([f.kind for f in got], ["replaced"])
        self.assertIn("spec.storageClassName", got[0].detail)

    def test_renamed_or_moved_object_is_replaced(self):
        moved = pvc()
        moved["inputs"]["metadata"]["namespace"] = "other"
        self.assertEqual([f.kind for f in compare("demo", [pvc()], [moved])], ["replaced"])

    def test_new_logical_name_deletes_the_old_resource(self):
        # Same Kubernetes object, new Pulumi name (or parent): Pulumi deletes the old one.
        renamed = pvc()
        renamed["urn"] = renamed["urn"].replace("::data", "::data-v2")
        renamed["name"] = "data-v2"
        self.assertEqual(self.kinds([pvc()], [renamed]), [("deleted", f"{PVC}::data")])

    def test_removed_namespace_is_data_loss(self):
        ns = res(NS, "demo-ns", {"metadata": {"name": "demo"}})
        self.assertEqual(self.kinds([ns], []), [("deleted", f"{NS}::demo-ns")])

    def test_renamed_namespace_is_data_loss(self):
        old = res(NS, "demo-ns", {"metadata": {"name": "demo"}})
        new = res(NS, "demo-ns", {"metadata": {"name": "demo2"}})
        self.assertEqual([f.kind for f in compare("demo", [old], [new])], ["replaced"])

    def test_statefulset_claim_template_change_is_data_loss(self):
        def sts(size):
            return res(STS, "db", {"metadata": {"name": "db"}, "spec": {"volumeClaimTemplates": [{"size": size}]}})

        self.assertEqual([f.kind for f in compare("demo", [sts("1Gi")], [sts("2Gi")])], ["replaced"])

    def test_statefulset_without_claims_is_not(self):
        sts = res(STS, "web", {"metadata": {"name": "web"}, "spec": {"replicas": 1}})
        self.assertEqual(self.kinds([sts], []), [])

    def test_removed_postgres_longhorn_and_helm_release_are_data_loss(self):
        base = [res(CNPG, "pg"), res(LONGHORN, "vol"), res(RELEASE, "chat", {"name": "chat"})]
        self.assertEqual([f.kind for f in compare("demo", base, [])], ["deleted"] * 3)

    def test_helm_release_rename_is_data_loss(self):
        old = res(RELEASE, "chat", {"name": "chat", "namespace": "chat"})
        new = res(RELEASE, "chat", {"name": "chat2", "namespace": "chat"})
        self.assertEqual([f.kind for f in compare("demo", [old], [new])], ["replaced"])

    def test_other_kinds_are_never_reported(self):
        svc = res(SVC, "web", {"metadata": {"name": "web"}})
        renamed = res(SVC, "web", {"metadata": {"name": "web2"}})
        self.assertEqual(self.kinds([svc, deploy()], [renamed]), [])


class ApprovedTest(unittest.TestCase):
    def review(self, user, state, commit="head", at="2026-11-12T10:00:00Z"):
        return {"user": {"login": user}, "state": state, "commit_id": commit, "submitted_at": at}

    def test_owner_approval_on_the_head_commit(self):
        self.assertTrue(approved([self.review("owner", "APPROVED")], "owner", "head"))

    def test_approval_of_an_older_commit_does_not_count(self):
        self.assertFalse(approved([self.review("owner", "APPROVED", commit="old")], "owner", "head"))

    def test_other_approvers_do_not_count(self):
        self.assertFalse(approved([self.review("someone", "APPROVED")], "owner", "head"))

    def test_latest_decision_wins_comments_do_not_reset(self):
        reviews = [
            self.review("owner", "APPROVED", at="2026-11-12T10:00:00Z"),
            self.review("owner", "COMMENTED", at="2026-11-12T11:00:00Z"),
        ]
        self.assertTrue(approved(reviews, "owner", "head"))
        reviews.append(self.review("owner", "CHANGES_REQUESTED", at="2026-11-12T12:00:00Z"))
        self.assertFalse(approved(reviews, "owner", "head"))


class CommentTest(unittest.TestCase):
    def test_lists_findings_and_names_the_limit(self):
        body = comment_body([Finding("demo", "deleted", f"{PVC}::data", "")])
        self.assertIn(data_loss.MARKER, body)
        self.assertIn(f"{PVC}::data", body)
        self.assertIn("live state", body)

    def test_all_clear_after_earlier_findings(self):
        self.assertIn("No data loss", comment_body([]))


# ---------------------------------------------------------------------------
# End to end: two repository trees, rendered with render_app.cjs
# ---------------------------------------------------------------------------

APP_TS = """\
import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import {{ createAppNamespace }} from '@mrsimpson/homelab-core-components';

const cfg = new pulumi.Config('demo');
const homelab = new pulumi.StackReference(cfg.require('homelabStack'));
const domain = homelab.getOutput('domain');
const token = cfg.requireSecret('token');
// Must not reach the network: the renderer stubs fetch.
const remote = pulumi.output(fetch('https://render.invalid/models').then((r) => r.json()));

const {{ namespace: ns }} = createAppNamespace('{namespace}');
{pvc}
new k8s.apps.v1.Deployment('demo', {{
  metadata: {{ name: 'demo', namespace: ns.metadata.name }},
  spec: {{
    selector: {{ matchLabels: {{ app: 'demo' }} }},
    template: {{
      metadata: {{ labels: {{ app: 'demo' }}, annotations: {{ host: pulumi.interpolate`demo.${{domain}}` }} }},
      spec: {{ containers: [{{ name: 'app', image: '{image}', env: [{{ name: 'T', value: token }}, {{ name: 'R', value: remote.apply(JSON.stringify) }}] }}] }},
    }},
  }},
}});
"""

PVC_TS = """\
new k8s.core.v1.PersistentVolumeClaim('demo-data', {
  metadata: { name: 'demo-data', namespace: ns.metadata.name },
  spec: { accessModes: ['ReadWriteOnce'], storageClassName: 'longhorn-persistent', resources: { requests: { storage: '1Gi' } } },
});
"""


def write_app(root, name="demo", namespace="demo", image="nginx:1", with_pvc=True, project=None):
    d = root / "apps" / name
    (d / "src").mkdir(parents=True)
    (d / "Pulumi.yaml").write_text(f"name: {project or name}\nruntime: nodejs\nmain: src/\n")
    (d / "Pulumi.dev.yaml").write_text(
        textwrap.dedent(
            """\
            config:
              demo:homelabStack: mrsimpson/homelab/dev
              demo:token:
                secure: AAABAnotarealsecret
            """
        )
    )
    (d / "src" / "index.ts").write_text(
        APP_TS.format(namespace=namespace, image=image, pvc=PVC_TS if with_pvc else "")
    )


@unittest.skipUnless(HAS_NODE_MODULES, "needs node_modules (npm ci)")
class EndToEndTest(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.base, self.head = self.tmp / "base", self.tmp / "head"
        for tree in (self.base, self.head):
            tree.mkdir()
            os.symlink(ROOT / "node_modules", tree / "node_modules")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def kinds(self):
        return sorted((f.kind, f.resource) for f in check(self.base, self.head))

    def test_unchanged_app_is_not_rendered(self):
        write_app(self.base)
        write_app(self.head)
        self.assertEqual(changed_apps(self.base, self.head), [])

    def test_removed_pvc(self):
        write_app(self.base)
        write_app(self.head, with_pvc=False)
        self.assertEqual(self.kinds(), [("deleted", f"{PVC}::demo-data")])

    def test_renamed_namespace(self):
        write_app(self.base)
        write_app(self.head, namespace="demo2")
        got = self.kinds()
        self.assertIn(("deleted", f"{NS}::demo-ns"), got)
        self.assertIn(("replaced", f"{PVC}::demo-data"), got)

    def test_image_only_change(self):
        write_app(self.base, image="nginx:1")
        write_app(self.head, image="nginx:2")
        self.assertEqual(changed_apps(self.base, self.head), ["demo"])
        self.assertEqual(self.kinds(), [])

    def test_removed_app_directory(self):
        write_app(self.base)
        (self.head / "apps").mkdir()
        self.assertEqual(self.kinds(), [("app-removed", "apps/demo/")])

    def test_renamed_pulumi_project(self):
        write_app(self.base)
        write_app(self.head, project="demo2")
        self.assertIn(("project-renamed", "apps/demo/Pulumi.yaml"), self.kinds())

    def test_render_failure_needs_review(self):
        write_app(self.base)
        write_app(self.head)
        (self.head / "apps/demo/src/index.ts").write_text("throw new Error('broken');\n")
        self.assertEqual([k for k, _ in self.kinds()], ["render-failed"])

    def test_render_is_deterministic_and_offline(self):
        write_app(self.base)
        once = data_loss.render(self.base / "apps" / "demo", ROOT / ".github/scripts/render_app.cjs")
        twice = data_loss.render(self.base / "apps" / "demo", ROOT / ".github/scripts/render_app.cjs")
        self.assertEqual(json.dumps(once), json.dumps(twice))
        env = next(r for r in once if r["type"] == DEPLOY)["inputs"]["spec"]["template"]["spec"]["containers"][0]["env"]
        self.assertEqual(env[0]["value"], data_loss.SECRET_PLACEHOLDER)


@unittest.skipUnless(HAS_NODE_MODULES, "needs node_modules (npm ci)")
class RealAppsTest(unittest.TestCase):
    """Every app in this repository renders offline, and renders the same way twice."""

    def test_all_apps_render(self):
        renderer = ROOT / ".github/scripts/render_app.cjs"
        for app in sorted((ROOT / "apps").glob("*/Pulumi.yaml")):
            with self.subTest(app=app.parent.name):
                once = data_loss.render(app.parent, renderer)
                self.assertTrue(any(r["type"] == NS for r in once), "renders its namespace")
                self.assertEqual(json.dumps(once), json.dumps(data_loss.render(app.parent, renderer)))


if __name__ == "__main__":
    unittest.main()
