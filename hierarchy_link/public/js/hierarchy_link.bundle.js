// Hierarchy Link
// ==============
// Registers `frappe.ui.form.ControlHierarchyLink` as a separate Control
// class for the "Hierarchy Link" fieldtype. It inherits from ControlLink
// and reuses the existing Awesomplete dropdown - we only swap the items
// it renders so they appear in tree order with collapse/expand chevrons.
//
// IMPORTANT: ControlLink itself is left completely untouched. Plain Link
// fields keep Frappe's default look and behaviour, even when their target
// DocType is a tree - users opt in to the hierarchy picker by choosing
// the "Hierarchy Link" fieldtype.
//
// Why inherit instead of redrawing?
//   - The dropdown chrome (border, shadow, padding, hover, dark-mode,
//     keyboard navigation, "Create a new ..." / "Advanced Search" footer
//     items) all come from core's ControlLink. If Frappe redesigns the
//     Link field, the tree picker inherits the new look automatically.
//   - All we patch is `on_input`: when tree mode is active, instead of
//     fetching `frappe.desk.search.search_link` results, we fetch the
//     records of the linked is_tree DocType ordered by `lft` and feed the
//     same Awesomplete with hierarchically-rendered items.

frappe.provide("hierarchy_link");

// ---------------------------------------------------------------
// Form Builder picker registration
// ---------------------------------------------------------------
// The drag-and-drop Form Builder ("Form" tab in the DocType editor) reads
// its fieldtype list from `frappe.model.all_fieldtypes` - a hard-coded JS
// array. We extend it so "Hierarchy Link" appears in the "Add field"
// autocomplete alongside "Link". This runs at script-load time so it
// happens before the Form Builder Vue tree mounts.
(() => {
	if (!frappe?.model?.all_fieldtypes) return;
	const list = frappe.model.all_fieldtypes;
	if (list.includes("Hierarchy Link")) return;
	const link_idx = list.indexOf("Link");
	if (link_idx >= 0) {
		list.splice(link_idx + 1, 0, "Hierarchy Link");
	} else {
		list.push("Hierarchy Link");
	}
})();

// ---------------------------------------------------------------
// Form Builder Vue control registration
// ---------------------------------------------------------------
// The Form Builder renders each field through a Vue component named
// `<fieldtype>Control` (see Field.vue:32-34 in core). For "Hierarchy Link"
// it would look for `HierarchyLinkControl`, which does not exist - so the
// field renders as an empty bar without label / duplicate / delete icons.
//
// We can't register a new global Vue component without modifying the
// Form Builder's bundle, but we *can* hook into `SetVueGlobals` (a global
// helper called for every Vue app the framework spins up). We wrap each
// new `app.mount` so that just before mounting we copy the already-
// registered `LinkControl` over to `HierarchyLinkControl`. This way the
// hierarchy link reuses the exact Link preview - same label slot, same
// duplicate/delete buttons, same options, identical look.
(() => {
	if (typeof window.SetVueGlobals !== "function") return;
	if (window.SetVueGlobals._hierarchy_link_patched) return;

	const original = window.SetVueGlobals;
	const patched = function (app) {
		original(app);
		if (!app || typeof app.mount !== "function") return;

		const original_mount = app.mount.bind(app);
		app.mount = function (...args) {
			try {
				const link_control = app.component("LinkControl");
				if (link_control && !app.component("HierarchyLinkControl")) {
					// Register the alias so the Form Builder's
					// `<fieldtype>Control` lookup resolves for
					// "Hierarchy Link" exactly as it does for "Link".
					app.component("HierarchyLinkControl", link_control);
				}
			} catch (e) {
				// ignore
			}
			return original_mount(...args);
		};
	};
	patched._hierarchy_link_patched = true;
	window.SetVueGlobals = patched;
})();

(() => {
	if (!frappe?.ui?.form?.ControlLink) return;

	const _is_tree_cache = {};

	hierarchy_link.is_tree_doctype = async function (doctype) {
		if (!doctype) return false;
		if (doctype in _is_tree_cache) return _is_tree_cache[doctype];

		try {
			await frappe.model.with_doctype(doctype);
			const meta = frappe.get_meta(doctype);
			_is_tree_cache[doctype] = Boolean(meta && cint(meta.is_tree));
		} catch (e) {
			_is_tree_cache[doctype] = false;
		}
		return _is_tree_cache[doctype];
	};

	// ---------------------------------------------------------------
	// Tree picker mixin
	// ---------------------------------------------------------------
	// All tree-rendering / filtering / chevron logic lives here. It is
	// applied only to ControlHierarchyLink.prototype - never to ControlLink.
	const TreePickerMixin = {
		async _hl_tree_on_input(e) {
			// Tree mode shows the full tree on open. The current input value
			// (which usually equals the field's value) is NOT used as a
			// filter unless the user actively types - otherwise re-opening
			// the picker after a selection would only show the selected
			// row's path instead of letting the user browse the tree.
			const term = e ? e.target.value || "" : "";
			this._hl_search_term = term;
			const doctype = this.get_options();
			if (!doctype) {
				return;
			}

			// Fetch records when the cache is invalidated (on every open,
			// or when the linked doctype changes). Filtering and
			// expand/collapse happen client-side so the dropdown is
			// responsive while typing.
			if (
				!this._hl_tree_records ||
				this._hl_tree_records_doctype !== doctype ||
				this._hl_tree_records_stale
			) {
				this._hl_tree_records_stale = false;
				const previous_names = this._hl_tree_records
					? new Set(this._hl_tree_records.map((r) => r.name))
					: null;

				this._hl_tree_records = await this._hl_fetch_tree_records(doctype);
				this._hl_tree_records_doctype = doctype;
				this._hl_tree_children_of = this._hl_build_children_map(
					this._hl_tree_records
				);

				if (!this._hl_expanded) {
					this._hl_expanded = new Set();
				}

				// Expand the path leading to the field's current value (if any)
				// so the user sees their selection without having to navigate.
				const current = this.get_value && this.get_value();
				if (current) {
					this._hl_expand_ancestors(current);
				}

				// Auto-expand the path to any records that appeared since the
				// previous fetch (within the same browser session) - so a
				// freshly-created node is visible right away after the user
				// returns to the picker.
				if (previous_names) {
					this._hl_tree_records.forEach((rec) => {
						if (!previous_names.has(rec.name)) {
							this._hl_expand_ancestors(rec.name);
						}
					});
				}

				// Also auto-expand any record that appeared since the user
				// clicked "Create a new ..." or "Advanced Search". This covers
				// cross-page navigation, where `previous_names` is unavailable
				// because the control was destroyed and recreated.
				//
				// `previous_names` (the snapshot taken at click time) is the
				// authoritative source: anything not in it is "new". We compare
				// against the snapshot persisted in sessionStorage so timezone
				// differences between browser and server don't matter.
				const pending = this._hl_consume_pending_create(doctype);
				if (pending && pending.names) {
					const seen = new Set(pending.names);
					this._hl_tree_records.forEach((rec) => {
						if (!seen.has(rec.name)) {
							this._hl_expand_ancestors(rec.name);
						}
					});
				}
			}

			const items = this._hl_compute_visible_items(term);
			this._hl_append_footer_items(items, doctype);

			// Awesomplete will re-render the dropdown with these items
			// using the same DOM / styling as the regular Link field.
			this.awesomplete.list = items;

			// Wire up chevron click handlers (delegated on the stable ul
			// element). Idempotent: removed before re-adding so we never
			// stack listeners.
			this._hl_bind_chevron_handlers();
		},

		_hl_bind_chevron_handlers() {
			if (!this.awesomplete || !this.awesomplete.ul) return;
			const ul = this.awesomplete.ul;
			if (ul._hl_bound) return;
			ul._hl_bound = true;

			// Chevron = expand/collapse only. Clicks anywhere else on the
			// row fall through to the standard Awesomplete select pipeline,
			// so any node (group or leaf) can be selected by clicking its
			// label - exactly like the native Link field. The capture phase
			// runs BEFORE Awesomplete's own selection listener so the
			// chevron click never produces a value change.
			const handle = (e) => {
				if (!e.target.closest(".hl-chevron")) return;
				e.preventDefault();
				e.stopImmediatePropagation();
			};
			ul.addEventListener("mousedown", handle, true);
			ul.addEventListener("click", (e) => {
				const chev = e.target.closest(".hl-chevron");
				if (!chev) return;
				e.preventDefault();
				e.stopImmediatePropagation();
				const name = chev.dataset.hlNode;
				if (name) this._hl_toggle_node(name);
			}, true);
		},

		_hl_toggle_node(name) {
			if (!this._hl_expanded) this._hl_expanded = new Set();
			if (this._hl_expanded.has(name)) {
				this._hl_expanded.delete(name);
			} else {
				this._hl_expanded.add(name);
			}

			// Use the active search term tracked by `_hl_tree_on_input`,
			// not the input value (which equals the selected record's name).
			const term = this._hl_search_term || "";
			const items = this._hl_compute_visible_items(term);
			this._hl_append_footer_items(items, this.get_options());
			this.awesomplete.list = items;
			this.awesomplete.open();
		},

		_hl_expand_ancestors(name) {
			if (!this._hl_tree_records || !this._hl_expanded) return;
			const by_name = new Map();
			this._hl_tree_records.forEach((r) => by_name.set(r.name, r));
			let cur = by_name.get(name);
			while (cur && cur._hl_parent) {
				this._hl_expanded.add(cur._hl_parent);
				cur = by_name.get(cur._hl_parent);
			}
		},

		_hl_build_children_map(records) {
			const map = new Map();
			records.forEach((rec) => {
				const p = rec._hl_parent || "";
				if (!map.has(p)) map.set(p, []);
				map.get(p).push(rec);
			});
			return map;
		},

		_hl_compute_visible_items(search_term) {
			const records = this._hl_tree_records || [];
			const children_of = this._hl_tree_children_of;
			if (!children_of) return [];

			const term = (search_term || "").toLowerCase();
			const has_search = !!term;

			// When searching, force-show every record whose name or title
			// matches, plus all of its ancestors so the path stays connected.
			let visible_set = null;
			if (has_search) {
				const by_name = new Map();
				records.forEach((r) => by_name.set(r.name, r));
				visible_set = new Set();
				records.forEach((rec) => {
					const matches_name = rec.name.toLowerCase().includes(term);
					const matches_title = rec._hl_title && rec._hl_title.toLowerCase().includes(term);
					if (!matches_name && !matches_title) return;
					visible_set.add(rec.name);
					let p = rec._hl_parent;
					while (p && !visible_set.has(p)) {
						visible_set.add(p);
						const parent_rec = by_name.get(p);
						p = parent_rec ? parent_rec._hl_parent : null;
					}
				});
			}

			const result = [];
			const expanded = this._hl_expanded || new Set();
			const walk = (parent_name, depth) => {
				const kids = children_of.get(parent_name) || [];
				for (const rec of kids) {
					if (visible_set && !visible_set.has(rec.name)) continue;
					const has_kids =
						cint(rec.is_group) &&
						(children_of.get(rec.name) || []).length > 0;
					// During a search, force-expand so users see all matches.
					const is_open = has_search || expanded.has(rec.name);
					result.push(this._hl_render_item(rec, depth, has_kids, is_open));
					if (has_kids && is_open) {
						walk(rec.name, depth + 1);
					}
				}
			};
			walk("", 0);
			return result;
		},

		_hl_render_item(rec, depth, has_kids, is_open) {
			const indent = depth * 16;
			const escape_attr = (s) =>
				String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
			const chevron = has_kids
				? `<span class="hl-chevron ${is_open ? "open" : ""}" data-hl-node="${escape_attr(rec.name)}" aria-label="${__("Expand / collapse")}">
					<i class="fa ${is_open ? "fa-caret-down" : "fa-caret-right"}"></i>
				</span>`
				: `<span class="hl-chevron-spacer"></span>`;
			// Display the title field (like the standard Link field) when
			// `show_title_field_in_link` is enabled on the linked DocType.
			// The title becomes the primary label and the name is shown as
			// a smaller description underneath - matching Frappe's Link UX.
			const display_label = rec._hl_title || rec.name;
			const is_title_link = !!this._hl_title_field;
			let label_html = `<strong>${frappe.utils.escape_html(display_label)}</strong>`;
			if (is_title_link && rec._hl_title && rec._hl_title !== rec.name) {
				label_html += `<br><span class="small">${frappe.utils.escape_html(rec.name)}</span>`;
			}
			return {
				value: rec.name,
				label: display_label,
				html:
					`<span class="hl-tree-item" style="padding-left: ${indent}px;">` +
					`${chevron}<span class="hl-tree-label">${label_html}</span>` +
					`</span>`,
			};
		},

		_hl_append_footer_items(items, doctype) {
			if (cint(this.df && this.df.only_select)) return;
			if (frappe.model.can_create(doctype)) {
				items.push({
					html:
						"<span class='link-option'>" +
						"<i class='fa fa-plus' style='margin-right: 5px;'></i> " +
						frappe.utils.escape_html(
							__("Create a new {0}", [__(doctype)])
						) +
						"</span>",
					label: __("Create a new {0}", [__(doctype)]),
					value: "create_new__link_option",
					action: () => {
						this._hl_mark_pending_create(doctype);
						return this.new_doc();
					},
				});
			}
			if (this.frm) {
				items.push({
					html:
						"<span class='link-option'>" +
						"<i class='fa fa-search' style='margin-right: 5px;'></i> " +
						frappe.utils.escape_html(__("Advanced Search")) +
						"</span>",
					label: __("Advanced Search"),
					value: "advanced_search__link_option",
					action: () => {
						this._hl_mark_pending_create(doctype);
						return this.open_advanced_search();
					},
				});
			}
		},

		// Persist a snapshot of the records that existed at the moment the
		// user clicked "Create a new ..." or "Advanced Search". We use
		// sessionStorage (per-tab) so the marker survives the page navigation
		// to the new-doc form and back.
		_hl_pending_storage_key(doctype) {
			return "hl_pending_create:" + doctype;
		},

		_hl_mark_pending_create(doctype) {
			try {
				const names = (this._hl_tree_records || []).map((r) => r.name);
				sessionStorage.setItem(
					this._hl_pending_storage_key(doctype),
					JSON.stringify({ names, ts: Date.now() })
				);
			} catch (e) {
				// sessionStorage unavailable - ignore.
			}
		},

		_hl_consume_pending_create(doctype) {
			try {
				const key = this._hl_pending_storage_key(doctype);
				const raw = sessionStorage.getItem(key);
				if (!raw) return null;
				sessionStorage.removeItem(key);
				const parsed = JSON.parse(raw);
				if (parsed && Array.isArray(parsed.names)) {
					return parsed;
				}
			} catch (e) {
				// sessionStorage unavailable or corrupt - ignore.
			}
			return null;
		},

		async _hl_fetch_tree_records(doctype) {
			// NestedSet convention: parent field is `parent_<doctype_snake>`.
			const parent_field =
				"parent_" + doctype.toLowerCase().replace(/[\s-]+/g, "_");

			// Resolve the title field (if any) so we can display it
			// like the standard Link field does.
			await frappe.model.with_doctype(doctype);
			const meta = frappe.get_meta(doctype);
			const title_field =
				meta && meta.show_title_field_in_link && meta.title_field
					? meta.title_field
					: null;
			this._hl_title_field = title_field;

			const fields = [
				"name",
				`${parent_field} as _hl_parent`,
				"is_group",
				"lft",
				"rgt",
				"creation",
				"modified",
			];
			if (title_field && title_field !== "name") {
				fields.push(`${title_field} as _hl_title`);
			}

			const args = {
				doctype,
				fields,
				order_by: "lft asc",
				limit_page_length: 0,
			};

			let r;
			try {
				r = await frappe.call({
					method: "frappe.client.get_list",
					args,
					no_spinner: true,
				});
			} catch (err) {
				console.error("hierarchy_link: tree fetch failed", err);
				return [];
			}
			return (r && r.message) || [];
		},
	};

	// ---------------------------------------------------------------
	// Register the dedicated Hierarchy Link Control class.
	// ---------------------------------------------------------------
	// `frappe.ui.form.make_control` resolves a fieldtype to a class by
	// stripping spaces - "Hierarchy Link" → ControlHierarchyLink.
	//
	// ControlLink itself is left untouched so plain Link fields keep
	// Frappe's default look exactly as the framework ships it.
	frappe.ui.form.ControlHierarchyLink = class ControlHierarchyLink extends frappe.ui.form.ControlLink {
		make_input() {
			super.make_input();

			// Mirror the standard Link field's focus behaviour:
			// `frappe/.../controls/link.js:37-45` only triggers `on_input`
			// when `$input.val()` is empty. Clicking on a populated input
			// just places the cursor and lets the user select / edit the
			// existing text - the dropdown stays closed until the value
			// actually changes (Awesomplete fires its own `input` listener
			// which routes through `on_input` -> `_hl_tree_on_input`, so
			// clearing the field re-renders the tree as expected).
			//
			// We mark the cache stale so the next call to `_hl_tree_on_input`
			// re-fetches records - that way any node created via "Create a
			// new ..." or Advanced Search in between shows up immediately,
			// with its ancestors auto-expanded.
			this.$input.on("focus.hl_tree", async () => {
				if (this.$input.val()) return;
				this._hl_tree_records_stale = true;
				await this._hl_tree_on_input();
				this.awesomplete && this.awesomplete.open();
			});

			// Invalidate the cache whenever the user comes back to this tab
			// (e.g. after creating a record in another tab) or when the page
			// is restored from the browser's back-forward cache.
			$(document).on("visibilitychange.hl_tree", () => {
				if (!document.hidden) {
					this._hl_tree_records_stale = true;
				}
			});
			$(window).on("pageshow.hl_tree", (e) => {
				if (e.originalEvent && e.originalEvent.persisted) {
					this._hl_tree_records_stale = true;
				}
			});
		}

		// Always route through the tree fetcher - never the flat search.
		on_input(e) {
			return this._hl_tree_on_input(e);
		}

		set_options(...args) {
			const out = super.set_options(...args);
			// Invalidate cached tree records when the linked doctype changes.
			this._hl_tree_records = null;
			this._hl_tree_records_doctype = null;
			return out;
		}

		// When a new record is created via "Create a new ..." or selected
		// from Advanced Search, invalidate the cache so the next open shows
		// the freshly-created node in its proper hierarchy position.
		parse_validate_and_set_in_model(value, e, label) {
			if (
				value &&
				this._hl_tree_records &&
				!this._hl_tree_records.some((r) => r.name === value)
			) {
				this._hl_tree_records = null;
				this._hl_tree_records_doctype = null;
			}
			// When the user selects a node from the hierarchy picker,
			// resolve its title so the input displays the title (like
			// the standard Link field) instead of the raw name.
			if (value && this._hl_title_field && this._hl_tree_records) {
				const rec = this._hl_tree_records.find((r) => r.name === value);
				if (rec && rec._hl_title) {
					label = label || rec._hl_title;
					frappe.utils.add_link_title(this.get_options(), value, rec._hl_title);
				}
			}
			return super.parse_validate_and_set_in_model(value, e, label);
		}
	};

	// Tree-rendering helpers are inherited only by ControlHierarchyLink.
	Object.assign(frappe.ui.form.ControlHierarchyLink.prototype, TreePickerMixin);
})();

// ---------------------------------------------------------------
// List View title resolution for "Hierarchy Link" fields
// ---------------------------------------------------------------
// Frappe's ListView only resolves title fields for fieldtype "Link".
// We register a formatter and patch refresh() to also handle
// "Hierarchy Link" - matching the standard Link field behaviour.
(() => {
	// Use the same formatter as Link so titles from the cache are shown.
	if (frappe.form.formatters.Link) {
		frappe.form.formatters.HierarchyLink = frappe.form.formatters.Link;
	}

	const LV = frappe.views && frappe.views.ListView;
	if (!LV) return;

	const orig_refresh = LV.prototype.refresh;
	if (!orig_refresh) return;

	LV.prototype.refresh = function (...args) {
		return orig_refresh.apply(this, args).then(() =>
			this._hl_resolve_titles()
		);
	};

	LV.prototype._hl_resolve_titles = async function () {
		if (!this.data || !this.data.length) return;

		const link_title_doctypes = frappe.boot?.link_title_doctypes || [];
		const hl_fields = [];

		for (const col of this.columns || []) {
			const df = col.df;
			if (
				df &&
				df.fieldtype === "Hierarchy Link" &&
				df.options &&
				link_title_doctypes.includes(df.options)
			) {
				hl_fields.push(df);
			}
		}
		if (!hl_fields.length) return;

		let needs_rerender = false;

		for (const df of hl_fields) {
			await frappe.model.with_doctype(df.options);
			const meta = frappe.get_meta(df.options);
			if (!meta || !meta.show_title_field_in_link || !meta.title_field) {
				continue;
			}

			const values = [
				...new Set(
					this.data
						.map((d) => d[df.fieldname])
						.filter(Boolean)
				),
			].filter((v) => !frappe.utils.get_link_title(df.options, v));

			if (!values.length) continue;

			const result = await frappe.call({
				method: "frappe.client.get_list",
				args: {
					doctype: df.options,
					fields: ["name", meta.title_field],
					filters: { name: ["in", values] },
					limit_page_length: 0,
				},
			});

			for (const rec of result.message || []) {
				frappe.utils.add_link_title(
					df.options,
					rec.name,
					rec[meta.title_field]
				);
				needs_rerender = true;
			}
		}

		if (needs_rerender) this.render();
	};
})();
