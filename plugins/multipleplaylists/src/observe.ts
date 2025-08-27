import type { LunaUnload } from "@luna/core";

/**
 * Minimal selector-based MutationObserver helper with unload integration.
 * - Immediately processes existing matches.
 * - Observes future additions under document.body.
 * - Ensures each element is processed once per observe() call.
 */
export function observe(unloads: Set<LunaUnload>, selector: string, onAdd: (el: Element) => void) {
	const processed = new WeakSet<Element>();

	const process = (root: ParentNode | Document) => {
		// Current DOM
		if ("querySelectorAll" in root) {
			const nodes = (root as Document | Element).querySelectorAll(selector);
			nodes.forEach((el) => {
				if (!processed.has(el)) {
					processed.add(el);
					onAdd(el);
				}
			});
		}
	};

	// Process existing matches
	process(document);

	const mo = new MutationObserver((mutations) => {
		for (const m of mutations) {
			if (m.type !== "childList") continue;

			m.addedNodes.forEach((n) => {
				if (n.nodeType !== 1) return; // ELEMENT_NODE
				const el = n as Element;

				// If the added node itself matches
				if (typeof el.matches === "function" && el.matches(selector)) {
					if (!processed.has(el)) {
						processed.add(el);
						onAdd(el);
					}
				}

				// Check descendants
				if (typeof el.querySelectorAll === "function") {
					el.querySelectorAll(selector).forEach((child) => {
						if (!processed.has(child)) {
							processed.add(child);
							onAdd(child);
						}
					});
				}
			});
		}
	});

	const start = () => {
		if (document.body) {
			mo.observe(document.body, { childList: true, subtree: true });
		} else {
			window.addEventListener(
				"DOMContentLoaded",
				() => mo.observe(document.body!, { childList: true, subtree: true }),
				{ once: true }
			);
		}
	};

	start();

	// Disconnect on unload
	unloads.add(() => mo.disconnect());
}