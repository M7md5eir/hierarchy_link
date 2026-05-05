"""Monkey-patches that register `Hierarchy Link` as a first-class fieldtype.

The patch runs once, when Frappe imports the `hierarchy_link` app (which it
does early during request startup when loading hooks). The patch is idempotent
- re-importing the module is a no-op.

Treatment: every backend code path that currently sees "Link" continues to see
"Link"; "Hierarchy Link" is added in parallel as an extra entry in the various
"valid fieldtype" registries. The DB column type is identical to a Link's
(varchar(140)).

The DocField.fieldtype Select dropdown is augmented separately, via a
Property Setter created during `after_install` (see `install.py`).
"""

from __future__ import annotations

import re
import sys

_HIERARCHY_FIELDTYPE = "Hierarchy Link"

# Matches a whole-word `doc.fieldtype` that is *not* already wrapped by our
# ternary substitution. Used to teach a depends_on expression that branches
# on Link to also branch on Hierarchy Link.
_DOC_FIELDTYPE_RE = re.compile(r"\bdoc\.fieldtype\b")
_HIERARCHY_FIELDTYPE_TERNARY = (
	"(doc.fieldtype === 'Hierarchy Link' ? 'Link' : doc.fieldtype)"
)


def _extend_data_fieldtypes() -> None:
	"""Add Hierarchy Link to `frappe.model.data_fieldtypes`.

	`data_fieldtypes` is a tuple, so we replace it with an extended tuple in
	`frappe.model` and rebind the same object on every module that has already
	imported it via `from frappe.model import data_fieldtypes`.
	"""

	import frappe.model

	old = frappe.model.data_fieldtypes
	if _HIERARCHY_FIELDTYPE in old:
		return

	new = tuple(old) + (_HIERARCHY_FIELDTYPE,)
	frappe.model.data_fieldtypes = new

	# Rebind in any module that already imported the tuple.
	for module in list(sys.modules.values()):
		if module is None:
			continue
		try:
			value = getattr(module, "data_fieldtypes", None)
		except Exception:
			continue
		if value is old:
			try:
				setattr(module, "data_fieldtypes", new)
			except Exception:
				# Read-only modules; ignore.
				pass


def _patch_database_type_map() -> None:
	"""Make every Frappe DB driver map Hierarchy Link → varchar(140).

	`setup_type_map` is called on each new connection. We wrap it so that
	whenever a connection is established, the type map gains a Hierarchy Link
	entry mirroring Link.
	"""

	def _patch(cls) -> None:
		if getattr(cls.setup_type_map, "_hierarchy_link_patched", False):
			return

		original = cls.setup_type_map

		def setup_type_map(self):
			original(self)
			if _HIERARCHY_FIELDTYPE not in self.type_map:
				self.type_map[_HIERARCHY_FIELDTYPE] = self.type_map.get(
					"Link", ("varchar", getattr(self, "VARCHAR_LEN", 140))
				)

		setup_type_map._hierarchy_link_patched = True  # type: ignore[attr-defined]
		cls.setup_type_map = setup_type_map

	# Each driver lives in its own optional module - patch what's available.
	# Newer Frappe ships parallel `mysqlclient` and `pymariadb` MariaDB
	# drivers; we patch every concrete Database subclass that defines its
	# own `setup_type_map`.
	for module_path, class_name in (
		("frappe.database.mariadb.database", "MariaDBDatabase"),
		("frappe.database.mariadb.mysqlclient", "MariaDBDatabase"),
		("frappe.database.mariadb.pymariadb", "PyMariaDBDatabase"),
		("frappe.database.postgres.database", "PostgresDatabase"),
		("frappe.database.sqlite.database", "SQLiteDatabase"),
	):
		try:
			module = __import__(module_path, fromlist=[class_name])
		except ImportError:
			continue
		cls = getattr(module, class_name, None)
		if cls is None:
			continue
		# Only patch classes that actually define `setup_type_map` on their
		# own MRO - otherwise we'd double-wrap a parent class.
		if "setup_type_map" in cls.__dict__:
			_patch(cls)

	# Also retro-fit any active connection that was created before the patch.
	try:
		import frappe

		live = getattr(frappe.local, "db", None)
		if live is not None and getattr(live, "type_map", None) is not None:
			if _HIERARCHY_FIELDTYPE not in live.type_map:
				live.type_map[_HIERARCHY_FIELDTYPE] = live.type_map.get(
					"Link", ("varchar", getattr(live, "VARCHAR_LEN", 140))
				)
	except Exception:
		# Frappe context not initialised yet - nothing to retrofit.
		pass


_FIELDTYPE_DOCTYPES = (
	"DocField",
	"Custom Field",
	"Customize Form Field",
)


def _patch_docfield_meta() -> None:
	"""Append `Hierarchy Link` to every fieldtype Select dropdown.

	Frappe stores the list of valid fieldtypes as the `options` of a Select
	field on three different DocTypes: `DocField` (the canonical schema),
	`Custom Field` (runtime additions), and `Customize Form Field` (the
	customisation UI). We extend all of them so the new fieldtype is
	available everywhere a developer can author a field.

	`DocField` is one of Frappe's `special_doctypes`, which means
	`Meta.process` skips the usual `apply_property_setters` step. So instead
	of relying on a Property Setter we wrap `Meta.process` itself and inject
	the option at meta-load time. The same wrapper handles all three
	doctypes uniformly.
	"""

	from frappe.model import meta as meta_module

	if getattr(meta_module.Meta.process, "_hierarchy_link_patched", False):
		return

	original = meta_module.Meta.process

	def process(self):
		original(self)
		try:
			if getattr(self, "name", None) in _FIELDTYPE_DOCTYPES:
				field = self.get_field("fieldtype")
				if field and field.options:
					options = field.options.split("\n")
					if _HIERARCHY_FIELDTYPE not in options:
						# Insert next to "Link" so the two related fieldtypes
						# sit together in the dropdown.
						if "Link" in options:
							options.insert(
								options.index("Link") + 1,
								_HIERARCHY_FIELDTYPE,
							)
						else:
							options.append(_HIERARCHY_FIELDTYPE)
						field.options = "\n".join(options)

				# Rewrite every per-property `depends_on` that switches on
				# `doc.fieldtype` so that a Hierarchy Link field is treated
				# exactly like a Link field. This makes the Form Builder's
				# right-hand property panel show Length, Mask, In Global
				# Search, Ignore User Permissions, Remember Last Selected
				# Value, etc. for Hierarchy Link - and hide Virtual, since
				# that one is hidden for Link too. Without this every Link-
				# specific property would silently disappear from the
				# Hierarchy Link panel.
				for f in self.fields or []:
					expr = getattr(f, "depends_on", None)
					if not expr or "doc.fieldtype" not in expr:
						continue
					if "'Link'" not in expr and '"Link"' not in expr:
						continue
					if _HIERARCHY_FIELDTYPE in expr:
						continue
					f.depends_on = _DOC_FIELDTYPE_RE.sub(
						_HIERARCHY_FIELDTYPE_TERNARY, expr
					)
		except Exception:
			# Never let a fieldtype patch break meta loading.
			pass

	process._hierarchy_link_patched = True  # type: ignore[attr-defined]
	meta_module.Meta.process = process


def _patch_validate_ignore_user_permissions() -> None:
	"""Make `validate_ignore_user_permissions` recognise Hierarchy Link as Link.

	Frappe's `frappe.desk.search.validate_ignore_user_permissions` only
	checks `fieldtype == "Link"` (and `Table MultiSelect` / `Dynamic Link`)
	when looking up the `options` of a link field used to filter a search.
	A Hierarchy Link is a Link in every meaningful sense - same column type,
	same `options` semantics - so the validator should treat the two
	identically. Without this patch, any link-filter (e.g. an Auto-set From
	on a Customer field that targets a Hierarchy Link parent) raises:

	  Error validating "Ignore User Permissions"
	  The field <Parent> in <DocType> links to None and not <DocType>

	because `found_doctype` is never populated for the Hierarchy Link
	branch and falls through to the final inequality check.

	We monkey-patch the function with a copy that adds Hierarchy Link
	wherever Link is recognised. Idempotent: re-importing this module is
	a no-op.
	"""

	from frappe.desk import search as search_module

	if getattr(
		search_module.validate_ignore_user_permissions,
		"_hierarchy_link_patched",
		False,
	):
		return

	def validate_ignore_user_permissions(form_doctype, link_fieldname, link_doctype):
		import frappe
		from frappe import _, bold
		from frappe.utils import escape_html

		def _throw(message):
			frappe.throw(message, title=_('Error validating "Ignore User Permissions"'))

		meta = frappe.get_meta(form_doctype)

		# Early exit: any Link / Hierarchy Link field on the form whose
		# options match the target doctype and which permits ignoring
		# user permissions is sufficient.
		if any(
			(
				field.fieldtype in ("Link", _HIERARCHY_FIELDTYPE)
				and field.options == link_doctype
				and field.ignore_user_permissions
			)
			for field in meta.fields
		):
			return

		link_field = meta.get_field(link_fieldname)
		if not link_field:
			_throw(
				_("Field <code>{0}</code> not found in {1}").format(
					escape_html(link_fieldname), bold(_(form_doctype))
				)
			)

		ignore_user_permissions = link_field.ignore_user_permissions
		found_doctype = None

		if link_field.fieldtype == "Table MultiSelect":
			child_meta = frappe.get_meta(link_field.options)
			child_link_field = next(
				(
					f
					for f in child_meta.fields
					if f.fieldtype in ("Link", _HIERARCHY_FIELDTYPE)
				),
				None,
			)
			if not child_link_field:
				_throw(
					_(
						"Table MultiSelect requires a table with at least one Link field, "
						"but none was found in {0}"
					).format(bold(_(link_field.options)))
				)

			found_doctype = child_link_field.options
			if not ignore_user_permissions:
				ignore_user_permissions = child_link_field.ignore_user_permissions

		if not ignore_user_permissions:
			_throw(
				_("The field {0} in {1} does not allow ignoring user permissions").format(
					bold(meta.get_label(link_fieldname)), bold(_(form_doctype))
				)
			)

		if link_field.fieldtype == "Dynamic Link":
			return

		if link_field.fieldtype in ("Link", _HIERARCHY_FIELDTYPE):
			found_doctype = link_field.options

		if found_doctype != link_doctype:
			_throw(
				_("The field {0} in {1} links to {2} and not {3}").format(
					bold(meta.get_label(link_fieldname)),
					bold(_(form_doctype)),
					bold(_(found_doctype)),
					bold(escape_html(link_doctype)),
				)
			)

	validate_ignore_user_permissions._hierarchy_link_patched = True  # type: ignore[attr-defined]
	search_module.validate_ignore_user_permissions = validate_ignore_user_permissions


_extend_data_fieldtypes()
_patch_database_type_map()
_patch_docfield_meta()
_patch_validate_ignore_user_permissions()
