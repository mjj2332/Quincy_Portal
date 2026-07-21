/* @ds-bundle: {"format":3,"namespace":"QuincyProductionsDesignSystem_b05a1c","components":[{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"Logo","sourcePath":"components/core/Logo.jsx"},{"name":"SectionHeader","sourcePath":"components/core/SectionHeader.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"}],"sourceHashes":{"components/core/Badge.jsx":"afa3c45087e0","components/core/Button.jsx":"5f4d94547f09","components/core/Card.jsx":"92d0f531b3d3","components/core/Logo.jsx":"2fa3a2c505da","components/core/SectionHeader.jsx":"9b964ee3f8a7","components/forms/Checkbox.jsx":"ccbae935ba1a","components/forms/Input.jsx":"23af9b12e5d9","components/forms/Select.jsx":"cb462d7452eb","components/forms/Switch.jsx":"070948330c73","ui_kits/website/Contact.jsx":"f5552ebc3d31","ui_kits/website/Footer.jsx":"e4e5f5d20469","ui_kits/website/Home.jsx":"a333422ecb0f","ui_kits/website/Nav.jsx":"5797f251b291","ui_kits/website/Studio.jsx":"e77caacc1463"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.QuincyProductionsDesignSystem_b05a1c = window.QuincyProductionsDesignSystem_b05a1c || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Quincy Productions — Badge / Tag
 * Spaced-caps label chip. "solid" is ink-filled; "outline" is hairline;
 * "soft" is paper-tinted. Square corners by default (the brand is editorial).
 */
function Badge({
  variant = "outline",
  tone = "ink",
  children,
  style = {},
  ...rest
}) {
  const tones = {
    ink: "var(--ink-900)",
    positive: "var(--signal-positive)",
    caution: "var(--signal-caution)",
    critical: "var(--signal-critical)",
    info: "var(--signal-info)"
  };
  const c = tones[tone] || tones.ink;
  const base = {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "5px 10px 4px",
    fontFamily: "var(--font-sans)",
    fontSize: "11px",
    letterSpacing: "var(--tracking-wide)",
    textTransform: "uppercase",
    lineHeight: 1,
    borderRadius: "var(--radius-xs)",
    border: "1px solid transparent",
    whiteSpace: "nowrap"
  };
  const variants = {
    solid: {
      background: c,
      color: "var(--paper-050)",
      borderColor: c
    },
    outline: {
      background: "transparent",
      color: c,
      borderColor: c
    },
    soft: {
      background: "var(--paper-100)",
      color: c,
      borderColor: "var(--border-hairline)"
    }
  };
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      ...base,
      ...(variants[variant] || variants.outline),
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Quincy Productions — Button
 * Editorial, square-ish, ink-on-paper. Primary is a solid ink fill;
 * secondary is a hairline outline; ghost is text-only; link is underlined.
 */
function Button({
  variant = "primary",
  size = "md",
  fullWidth = false,
  disabled = false,
  iconLeft = null,
  iconRight = null,
  as = "button",
  children,
  style = {},
  ...rest
}) {
  const sizes = {
    sm: {
      padding: "8px 16px",
      font: "13px",
      gap: "8px"
    },
    md: {
      padding: "12px 22px",
      font: "14px",
      gap: "10px"
    },
    lg: {
      padding: "16px 30px",
      font: "16px",
      gap: "12px"
    }
  };
  const s = sizes[size] || sizes.md;
  const base = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: s.gap,
    width: fullWidth ? "100%" : "auto",
    padding: s.padding,
    fontFamily: "var(--font-sans)",
    fontSize: s.font,
    fontWeight: 400,
    letterSpacing: "var(--tracking-wide)",
    textTransform: "uppercase",
    lineHeight: 1,
    borderRadius: "var(--radius-sm)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    transition: "background var(--dur-fast) var(--ease-standard), color var(--dur-fast) var(--ease-standard), transform var(--dur-fast) var(--ease-standard), border-color var(--dur-fast) var(--ease-standard)",
    border: "1.5px solid transparent",
    textDecoration: "none",
    whiteSpace: "nowrap",
    userSelect: "none"
  };
  const variants = {
    primary: {
      background: "var(--ink-900)",
      color: "var(--paper-050)",
      borderColor: "var(--ink-900)"
    },
    secondary: {
      background: "transparent",
      color: "var(--ink-900)",
      borderColor: "var(--ink-900)"
    },
    ghost: {
      background: "transparent",
      color: "var(--ink-900)",
      borderColor: "transparent"
    },
    inverse: {
      background: "var(--paper-050)",
      color: "var(--ink-900)",
      borderColor: "var(--paper-050)"
    },
    link: {
      background: "transparent",
      color: "var(--ink-900)",
      borderColor: "transparent",
      textTransform: "none",
      letterSpacing: "var(--tracking-normal)",
      textDecoration: "underline",
      textUnderlineOffset: "4px",
      padding: "4px 2px"
    }
  };
  const Comp = as;
  return /*#__PURE__*/React.createElement(Comp, _extends({
    disabled: as === "button" ? disabled : undefined,
    style: {
      ...base,
      ...(variants[variant] || variants.primary),
      ...style
    },
    onMouseDown: e => {
      if (!disabled && variant !== "link") e.currentTarget.style.transform = "translateY(1px)";
    },
    onMouseUp: e => {
      e.currentTarget.style.transform = "translateY(0)";
    },
    onMouseLeave: e => {
      e.currentTarget.style.transform = "translateY(0)";
    }
  }, rest), iconLeft, children, iconRight);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Quincy Productions — Card
 * Editorial surface. Default is a hairline-bordered square paper panel with no
 * shadow; "raised" adds a quiet shadow; "inverse" is ink with paper text.
 */
function Card({
  variant = "default",
  padding = "lg",
  children,
  style = {},
  ...rest
}) {
  const pads = {
    none: "0",
    sm: "16px",
    md: "24px",
    lg: "32px"
  };
  const base = {
    borderRadius: "var(--radius-card)",
    padding: pads[padding] ?? pads.lg,
    transition: "box-shadow var(--dur-base) var(--ease-standard), transform var(--dur-base) var(--ease-standard)"
  };
  const variants = {
    default: {
      background: "var(--bg-surface)",
      color: "var(--text-primary)",
      border: "1px solid var(--border-hairline)"
    },
    raised: {
      background: "var(--bg-surface)",
      color: "var(--text-primary)",
      border: "1px solid var(--border-subtle)",
      boxShadow: "var(--shadow-md)"
    },
    inverse: {
      background: "var(--bg-inverse)",
      color: "var(--text-on-inverse)",
      border: "1px solid var(--ink-900)"
    },
    ghost: {
      background: "transparent",
      color: "var(--text-primary)",
      border: "1px solid transparent"
    }
  };
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      ...base,
      ...(variants[variant] || variants.default),
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/Logo.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Quincy Productions — Logo
 * Renders the supplied brand marks as <img>. Picks black/white by `tone`.
 * `mark`: "wordmark" (Quincy Productions lockup) | "hero" (Quincy script) |
 * "qp" (interlocked monogram) | "pinwheel" (four-Q pattern tile).
 */
function Logo({
  mark = "wordmark",
  tone = "black",
  height,
  assetsBase = "assets",
  style = {},
  ...rest
}) {
  const files = {
    wordmark: {
      black: "logos/quincy-wordmark-black.png",
      white: "logos/quincy-wordmark-white.png"
    },
    hero: {
      black: "logos/quincy-hero-black.png",
      white: "logos/quincy-hero-q-white.png"
    },
    qp: {
      black: "logos/quincy-qp-black.png",
      white: "logos/quincy-qp-white.png"
    },
    pinwheel: {
      black: "patterns/quincy-pattern-black.png",
      white: "patterns/quincy-pattern-white.png"
    }
  };
  const set = files[mark] || files.wordmark;
  const src = assetsBase + "/" + (set[tone] || set.black);
  return /*#__PURE__*/React.createElement("img", _extends({
    src: src,
    alt: "Quincy Productions",
    style: {
      height: height || 40,
      width: "auto",
      display: "block",
      ...style
    }
  }, rest));
}
Object.assign(__ds_scope, { Logo });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Logo.jsx", error: String((e && e.message) || e) }); }

// components/core/SectionHeader.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Quincy Productions — SectionHeader
 * The editorial header lockup: a spaced-caps eyebrow, a Mazius display title,
 * and a 3px ink rule. The backbone of the brand's page rhythm.
 */
function SectionHeader({
  eyebrow,
  title,
  align = "left",
  rule = true,
  invert = false,
  style = {},
  ...rest
}) {
  const ink = invert ? "var(--paper-050)" : "var(--ink-900)";
  const muted = invert ? "var(--greige-200)" : "var(--greige-500)";
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      textAlign: align,
      ...style
    }
  }, rest), eyebrow && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: "12px",
      textTransform: "uppercase",
      letterSpacing: "var(--tracking-widest)",
      color: muted,
      marginBottom: "14px"
    }
  }, eyebrow), /*#__PURE__*/React.createElement("h2", {
    style: {
      font: "var(--type-h1)",
      letterSpacing: "var(--tracking-tight)",
      color: ink,
      margin: 0
    }
  }, title), rule && /*#__PURE__*/React.createElement("hr", {
    style: {
      border: 0,
      borderTop: "3px solid " + ink,
      margin: align === "center" ? "20px auto 0" : "20px 0 0",
      width: align === "center" ? "64px" : "100%"
    }
  }));
}
Object.assign(__ds_scope, { SectionHeader });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/SectionHeader.jsx", error: String((e && e.message) || e) }); }

// components/forms/Checkbox.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Quincy Productions — Checkbox
 * Square hairline box that fills with ink when checked. Editorial, no rounding.
 */
function Checkbox({
  label,
  checked,
  defaultChecked,
  onChange,
  disabled = false,
  style = {},
  ...rest
}) {
  const [internal, setInternal] = React.useState(!!defaultChecked);
  const isControlled = checked !== undefined;
  const on = isControlled ? checked : internal;
  function toggle() {
    if (disabled) return;
    if (!isControlled) setInternal(!on);
    onChange && onChange(!on);
  }
  return /*#__PURE__*/React.createElement("label", _extends({
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: "12px",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.45 : 1,
      fontFamily: "var(--font-sans)",
      fontSize: "15px",
      color: "var(--text-primary)",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("span", {
    onClick: toggle,
    role: "checkbox",
    "aria-checked": on,
    style: {
      width: "20px",
      height: "20px",
      flex: "none",
      border: "1.5px solid var(--ink-900)",
      borderRadius: "var(--radius-xs)",
      background: on ? "var(--ink-900)" : "transparent",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      transition: "background var(--dur-fast) var(--ease-standard)"
    }
  }, on && /*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "12",
    viewBox: "0 0 12 12",
    fill: "none"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M2 6.2L4.8 9L10 3",
    stroke: "var(--paper-050)",
    strokeWidth: "1.8",
    strokeLinecap: "square"
  }))), label && /*#__PURE__*/React.createElement("span", {
    onClick: toggle
  }, label));
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Quincy Productions — Input
 * Underline-forward field by default (editorial), or a boxed hairline variant.
 * Label is a spaced-caps eyebrow above the field.
 */
function Input({
  label,
  hint,
  error,
  variant = "underline",
  prefix = null,
  type = "text",
  style = {},
  id,
  ...rest
}) {
  const fieldId = id || (label ? "f-" + String(label).replace(/\W+/g, "-").toLowerCase() : undefined);
  const borderColor = error ? "var(--signal-critical)" : "var(--ink-900)";
  const boxed = {
    width: "100%",
    background: "var(--field-bg)",
    border: "1.5px solid " + (error ? "var(--signal-critical)" : "var(--border-hairline)"),
    borderRadius: "var(--radius-sm)",
    padding: "12px 14px"
  };
  const underline = {
    width: "100%",
    background: "transparent",
    border: "0",
    borderBottom: "1.5px solid " + borderColor,
    borderRadius: 0,
    padding: "8px 2px"
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      ...style
    }
  }, label && /*#__PURE__*/React.createElement("label", {
    htmlFor: fieldId,
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: "12px",
      textTransform: "uppercase",
      letterSpacing: "var(--tracking-wide)",
      color: "var(--text-secondary)"
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: "8px"
    }
  }, prefix && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-sans)",
      color: "var(--text-muted)"
    }
  }, prefix), /*#__PURE__*/React.createElement("input", _extends({
    id: fieldId,
    type: type,
    style: {
      ...(variant === "boxed" ? boxed : underline),
      fontFamily: "var(--font-sans)",
      fontSize: "16px",
      color: "var(--text-primary)",
      outline: "none"
    }
  }, rest))), (hint || error) && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: "12px",
      color: error ? "var(--signal-critical)" : "var(--text-muted)"
    }
  }, error || hint));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Quincy Productions — Select
 * Native select wrapped in the brand field styling (underline or boxed),
 * with a spaced-caps label and a hand-tuned chevron.
 */
function Select({
  label,
  hint,
  variant = "underline",
  children,
  style = {},
  id,
  ...rest
}) {
  const fieldId = id || (label ? "s-" + String(label).replace(/\W+/g, "-").toLowerCase() : undefined);
  const boxed = {
    background: "var(--field-bg)",
    border: "1.5px solid var(--border-hairline)",
    borderRadius: "var(--radius-sm)",
    padding: "12px 38px 12px 14px"
  };
  const underline = {
    background: "transparent",
    border: 0,
    borderBottom: "1.5px solid var(--ink-900)",
    borderRadius: 0,
    padding: "8px 32px 8px 2px"
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      ...style
    }
  }, label && /*#__PURE__*/React.createElement("label", {
    htmlFor: fieldId,
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: "12px",
      textTransform: "uppercase",
      letterSpacing: "var(--tracking-wide)",
      color: "var(--text-secondary)"
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      display: "inline-flex"
    }
  }, /*#__PURE__*/React.createElement("select", _extends({
    id: fieldId,
    style: {
      ...(variant === "boxed" ? boxed : underline),
      appearance: "none",
      WebkitAppearance: "none",
      fontFamily: "var(--font-sans)",
      fontSize: "16px",
      color: "var(--text-primary)",
      width: "100%",
      outline: "none",
      cursor: "pointer"
    }
  }, rest), children), /*#__PURE__*/React.createElement("span", {
    style: {
      position: "absolute",
      right: "10px",
      top: "50%",
      transform: "translateY(-50%)",
      pointerEvents: "none"
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "8",
    viewBox: "0 0 12 8",
    fill: "none"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M1 1L6 6L11 1",
    stroke: "var(--ink-900)",
    strokeWidth: "1.5",
    strokeLinecap: "square"
  })))), hint && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: "12px",
      color: "var(--text-muted)"
    }
  }, hint));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Quincy Productions — Switch
 * A flat, square-ended toggle. Ink track when on, hairline track when off.
 * Deliberately understated — the brand avoids glossy pill UI.
 */
function Switch({
  checked,
  defaultChecked,
  onChange,
  disabled = false,
  label,
  style = {},
  ...rest
}) {
  const [internal, setInternal] = React.useState(!!defaultChecked);
  const isControlled = checked !== undefined;
  const on = isControlled ? checked : internal;
  function toggle() {
    if (disabled) return;
    if (!isControlled) setInternal(!on);
    onChange && onChange(!on);
  }
  const track = {
    width: "44px",
    height: "24px",
    flex: "none",
    borderRadius: "var(--radius-pill)",
    border: "1.5px solid var(--ink-900)",
    background: on ? "var(--ink-900)" : "transparent",
    position: "relative",
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "background var(--dur-base) var(--ease-standard)"
  };
  const knob = {
    position: "absolute",
    top: "2px",
    left: on ? "22px" : "2px",
    width: "17px",
    height: "17px",
    borderRadius: "var(--radius-pill)",
    background: on ? "var(--paper-050)" : "var(--ink-900)",
    transition: "left var(--dur-base) var(--ease-entrance), background var(--dur-base) var(--ease-standard)"
  };
  return /*#__PURE__*/React.createElement("label", _extends({
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: "12px",
      opacity: disabled ? 0.45 : 1,
      fontFamily: "var(--font-sans)",
      fontSize: "15px",
      color: "var(--text-primary)",
      cursor: disabled ? "not-allowed" : "pointer",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("span", {
    role: "switch",
    "aria-checked": on,
    onClick: toggle,
    style: track
  }, /*#__PURE__*/React.createElement("span", {
    style: knob
  })), label && /*#__PURE__*/React.createElement("span", {
    onClick: toggle
  }, label));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Contact.jsx
try { (() => {
// Quincy Productions — Contact / start a project
const {
  SectionHeader,
  Input,
  Select,
  Checkbox,
  Button,
  Logo
} = window.QuincyProductionsDesignSystem_b05a1c;
function Contact() {
  const [sent, setSent] = React.useState(false);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      minHeight: "640px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--ink-900)",
      color: "var(--paper-050)",
      padding: "80px 56px",
      position: "relative",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      opacity: 0.06,
      backgroundImage: "url(../../assets/patterns/quincy-pattern-white.png)",
      backgroundRepeat: "repeat",
      backgroundSize: "200px"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative"
    }
  }, /*#__PURE__*/React.createElement(Logo, {
    mark: "qp",
    tone: "white",
    height: 88,
    assetsBase: "../../assets"
  }), /*#__PURE__*/React.createElement("h2", {
    style: {
      font: "var(--type-h1)",
      color: "var(--paper-050)",
      marginTop: "40px",
      letterSpacing: "var(--tracking-tight)"
    }
  }, "Let's make", /*#__PURE__*/React.createElement("br", null), "something lasting."), /*#__PURE__*/React.createElement("p", {
    style: {
      font: "var(--type-body-lg)",
      color: "var(--greige-200)",
      marginTop: "20px",
      maxWidth: "360px"
    }
  }, "Tell us about your project. We take on a handful of films each season and reply to every note personally."), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "48px",
      display: "flex",
      flexDirection: "column",
      gap: "8px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "q-eyebrow",
    style: {
      color: "var(--greige-200)"
    }
  }, "Direct"), /*#__PURE__*/React.createElement("span", {
    style: {
      font: "var(--type-body)",
      color: "var(--paper-050)"
    }
  }, "hello@quincy.co"), /*#__PURE__*/React.createElement("span", {
    style: {
      font: "var(--type-body)",
      color: "var(--paper-050)"
    }
  }, "+1 (212) 555-0148")))), /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--bg-surface)",
      padding: "80px 56px"
    }
  }, sent ? /*#__PURE__*/React.createElement("div", {
    style: {
      height: "100%",
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      gap: "16px"
    }
  }, /*#__PURE__*/React.createElement(SectionHeader, {
    eyebrow: "Received",
    title: "Thank you."
  }), /*#__PURE__*/React.createElement("p", {
    className: "q-body",
    style: {
      color: "var(--text-secondary)"
    }
  }, "We'll be in touch within one working day."), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    onClick: () => setSent(false)
  }, "Send another"))) : /*#__PURE__*/React.createElement("form", {
    onSubmit: e => {
      e.preventDefault();
      setSent(true);
    },
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "28px"
    }
  }, /*#__PURE__*/React.createElement(SectionHeader, {
    eyebrow: "Start a project",
    title: "Project brief",
    rule: false
  }), /*#__PURE__*/React.createElement(Input, {
    label: "Name",
    placeholder: "Your name",
    required: true
  }), /*#__PURE__*/React.createElement(Input, {
    label: "Email",
    type: "email",
    placeholder: "you@studio.com",
    required: true
  }), /*#__PURE__*/React.createElement(Select, {
    label: "What are we making?",
    defaultValue: "doc"
  }, /*#__PURE__*/React.createElement("option", {
    value: "doc"
  }, "Documentary"), /*#__PURE__*/React.createElement("option", {
    value: "brand"
  }, "Brand film"), /*#__PURE__*/React.createElement("option", {
    value: "series"
  }, "Series"), /*#__PURE__*/React.createElement("option", {
    value: "other"
  }, "Something else")), /*#__PURE__*/React.createElement(Input, {
    label: "In a sentence",
    placeholder: "The film is about\u2026"
  }), /*#__PURE__*/React.createElement(Checkbox, {
    label: "Add me to the seasonal dispatch",
    defaultChecked: true
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "lg",
    type: "submit",
    as: "button"
  }, "Send brief"))));
}
window.QPContact = Contact;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Contact.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Footer.jsx
try { (() => {
// Quincy Productions — site footer
const {
  Logo
} = window.QuincyProductionsDesignSystem_b05a1c;
function Footer() {
  return /*#__PURE__*/React.createElement("footer", {
    style: {
      background: "var(--ink-900)",
      color: "var(--paper-050)",
      padding: "64px 40px 40px",
      marginTop: "0",
      backgroundImage: "url(../../assets/patterns/quincy-pattern-white.png)",
      backgroundRepeat: "repeat",
      backgroundSize: "260px",
      backgroundBlendMode: "soft-light"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      flexWrap: "wrap",
      gap: "40px",
      borderBottom: "1px solid rgba(250,248,242,0.18)",
      paddingBottom: "40px"
    }
  }, /*#__PURE__*/React.createElement(Logo, {
    mark: "hero",
    tone: "white",
    height: 64,
    assetsBase: "../../assets"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "64px",
      flexWrap: "wrap"
    }
  }, [{
    h: "Studio",
    links: ["About", "Approach", "Team", "Careers"]
  }, {
    h: "Work",
    links: ["Documentary", "Brand films", "Series", "Archive"]
  }, {
    h: "Contact",
    links: ["hello@quincy.co", "+1 (212) 555-0148", "Brooklyn, NY"]
  }].map(col => /*#__PURE__*/React.createElement("div", {
    key: col.h,
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "12px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: "11px",
      textTransform: "uppercase",
      letterSpacing: "var(--tracking-widest)",
      color: "var(--greige-200)",
      marginBottom: "4px"
    }
  }, col.h), col.links.map(l => /*#__PURE__*/React.createElement("span", {
    key: l,
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: "14px",
      color: "var(--paper-050)",
      opacity: 0.85
    }
  }, l)))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      paddingTop: "24px",
      fontFamily: "var(--font-sans)",
      fontSize: "12px",
      color: "var(--greige-200)"
    }
  }, /*#__PURE__*/React.createElement("span", null, "\xA9 2026 Quincy Productions"), /*#__PURE__*/React.createElement("span", {
    style: {
      letterSpacing: "var(--tracking-wide)",
      textTransform: "uppercase"
    }
  }, "Stories, made with patience")));
}
window.QPFooter = Footer;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Footer.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Home.jsx
try { (() => {
// Quincy Productions — Home (hero + selected work)
const {
  Logo,
  Button,
  Badge,
  SectionHeader
} = window.QuincyProductionsDesignSystem_b05a1c;
const WORK = [{
  t: "Nightshift",
  k: "Documentary · 2025",
  d: "The people who keep a city awake."
}, {
  t: "Salt & Cedar",
  k: "Brand film · 2025",
  d: "A coastal distillery, in one long breath."
}, {
  t: "The Long Field",
  k: "Series · 2024",
  d: "Six growers, four seasons, one valley."
}, {
  t: "Marrow",
  k: "Short · 2024",
  d: "A portrait of the last bone-china kiln."
}];
function Home({
  onNav
}) {
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("section", {
    style: {
      background: "var(--ink-900)",
      color: "var(--paper-050)",
      padding: "96px 40px 88px",
      position: "relative",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      opacity: 0.06,
      backgroundImage: "url(../../assets/patterns/quincy-pattern-white.png)",
      backgroundRepeat: "repeat",
      backgroundSize: "220px"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      maxWidth: "var(--container-lg)",
      margin: "0 auto",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: "12px",
      textTransform: "uppercase",
      letterSpacing: "var(--tracking-widest)",
      color: "var(--greige-200)",
      marginBottom: "34px"
    }
  }, "A production house \xB7 Brooklyn"), /*#__PURE__*/React.createElement(Logo, {
    mark: "hero",
    tone: "white",
    height: 120,
    assetsBase: "../../assets",
    style: {
      margin: "0 auto 36px"
    }
  }), /*#__PURE__*/React.createElement("p", {
    style: {
      font: "var(--type-body-lg)",
      color: "var(--paper-050)",
      maxWidth: "620px",
      margin: "0 auto 40px",
      opacity: 0.9
    }
  }, "We make documentary, brand and narrative films with unhurried attention \u2014 stories that hold up long after the credits."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "16px",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "inverse",
    size: "lg",
    onClick: () => onNav("home")
  }, "View the reel"), /*#__PURE__*/React.createElement(Button, {
    variant: "ghost",
    size: "lg",
    style: {
      color: "var(--paper-050)"
    },
    onClick: () => onNav("contact")
  }, "Start a project")))), /*#__PURE__*/React.createElement("section", {
    style: {
      maxWidth: "var(--container-xl)",
      margin: "0 auto",
      padding: "80px 40px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-end",
      marginBottom: "40px"
    }
  }, /*#__PURE__*/React.createElement(SectionHeader, {
    eyebrow: "Selected work",
    title: "Recent films",
    rule: false
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "link",
    onClick: () => onNav("home")
  }, "Full archive \u2192")), /*#__PURE__*/React.createElement("hr", {
    className: "q-rule",
    style: {
      marginBottom: "0"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "0"
    }
  }, WORK.map((w, i) => /*#__PURE__*/React.createElement("article", {
    key: w.t,
    style: {
      padding: "32px 28px",
      borderBottom: "1px solid var(--border-hairline)",
      borderRight: i % 2 === 0 ? "1px solid var(--border-hairline)" : "none",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      minHeight: "210px",
      justifyContent: "space-between",
      cursor: "pointer",
      transition: "background var(--dur-base) var(--ease-standard)"
    },
    onMouseEnter: e => e.currentTarget.style.background = "var(--paper-100)",
    onMouseLeave: e => e.currentTarget.style.background = "transparent"
  }, /*#__PURE__*/React.createElement(Badge, {
    variant: "outline"
  }, String(i + 1).padStart(2, "0")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
    style: {
      font: "var(--type-h2)",
      letterSpacing: "var(--tracking-tight)",
      marginBottom: "8px"
    }
  }, w.t), /*#__PURE__*/React.createElement("p", {
    style: {
      font: "var(--type-body)",
      color: "var(--text-secondary)"
    }
  }, w.d)), /*#__PURE__*/React.createElement("div", {
    className: "q-eyebrow"
  }, w.k))))), /*#__PURE__*/React.createElement("section", {
    style: {
      background: "var(--paper-100)",
      borderTop: "1px solid var(--border-hairline)",
      borderBottom: "1px solid var(--border-hairline)",
      padding: "96px 40px"
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      font: "var(--type-statement)",
      textTransform: "uppercase",
      textAlign: "center",
      maxWidth: "1000px",
      margin: "0 auto",
      lineHeight: 1.02
    }
  }, "Patience is", /*#__PURE__*/React.createElement("br", null), "a production value")));
}
window.QPHome = Home;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Home.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Nav.jsx
try { (() => {
// Quincy Productions — site top navigation
const {
  Logo,
  Button
} = window.QuincyProductionsDesignSystem_b05a1c;
function Nav({
  current,
  onNav,
  invert
}) {
  const items = [{
    id: "home",
    label: "Work"
  }, {
    id: "studio",
    label: "Studio"
  }, {
    id: "contact",
    label: "Contact"
  }];
  const ink = invert ? "var(--paper-050)" : "var(--ink-900)";
  return /*#__PURE__*/React.createElement("header", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "22px 40px",
      borderBottom: "1px solid " + (invert ? "rgba(250,248,242,0.18)" : "var(--border-hairline)"),
      position: "sticky",
      top: 0,
      zIndex: 20,
      background: invert ? "var(--ink-900)" : "var(--bg-canvas)"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => onNav("home"),
    style: {
      border: 0,
      background: "none",
      cursor: "pointer",
      padding: 0,
      display: "flex",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement(Logo, {
    mark: "wordmark",
    tone: invert ? "white" : "black",
    height: 26,
    assetsBase: "../../assets"
  })), /*#__PURE__*/React.createElement("nav", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: "34px"
    }
  }, items.map(it => /*#__PURE__*/React.createElement("button", {
    key: it.id,
    onClick: () => onNav(it.id),
    style: {
      border: 0,
      background: "none",
      cursor: "pointer",
      padding: "4px 0",
      fontFamily: "var(--font-sans)",
      fontSize: "13px",
      textTransform: "uppercase",
      letterSpacing: "var(--tracking-wide)",
      color: ink,
      borderBottom: current === it.id ? "1.5px solid " + ink : "1.5px solid transparent"
    }
  }, it.label)), /*#__PURE__*/React.createElement(Button, {
    variant: invert ? "inverse" : "primary",
    size: "sm",
    onClick: () => onNav("contact")
  }, "Start a project")));
}
window.QPNav = Nav;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Nav.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Studio.jsx
try { (() => {
// Quincy Productions — Studio (about / approach)
const {
  SectionHeader,
  Card,
  Badge
} = window.QuincyProductionsDesignSystem_b05a1c;
const STEPS = [{
  n: "01",
  t: "Listen",
  d: "Every film begins with a long conversation. We learn the story before we light a frame."
}, {
  n: "02",
  t: "Develop",
  d: "Treatments, schedules and budgets that are honest about time. We plan for patience."
}, {
  n: "03",
  t: "Capture",
  d: "Small crews, careful presence. We shoot for truth, not coverage."
}, {
  n: "04",
  t: "Shape",
  d: "The edit is where the film is written. We cut until nothing extra remains."
}];
function Studio() {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: "var(--container-lg)",
      margin: "0 auto",
      padding: "80px 40px 96px"
    }
  }, /*#__PURE__*/React.createElement(SectionHeader, {
    eyebrow: "The studio",
    title: "A small house, built for the long take"
  }), /*#__PURE__*/React.createElement("p", {
    className: "q-body-serif",
    style: {
      maxWidth: "640px",
      marginTop: "28px",
      color: "var(--text-secondary)"
    }
  }, "Quincy Productions is an independent film studio in Brooklyn. We work with a deliberately short slate each year so that every project gets the time it deserves \u2014 from first conversation to final colour."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(4,1fr)",
      gap: "0",
      marginTop: "64px",
      borderTop: "3px solid var(--ink-900)"
    }
  }, STEPS.map((s, i) => /*#__PURE__*/React.createElement("div", {
    key: s.n,
    style: {
      padding: "28px 22px",
      borderRight: i < 3 ? "1px solid var(--border-hairline)" : "none",
      display: "flex",
      flexDirection: "column",
      gap: "14px",
      minHeight: "220px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-statement)",
      fontWeight: 700,
      fontSize: "40px",
      lineHeight: 1
    }
  }, s.n), /*#__PURE__*/React.createElement("h3", {
    style: {
      font: "var(--type-h3)"
    }
  }, s.t), /*#__PURE__*/React.createElement("p", {
    style: {
      font: "var(--type-body)",
      color: "var(--text-secondary)"
    }
  }, s.d)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr 1fr",
      gap: "16px",
      marginTop: "64px"
    }
  }, [{
    k: "Founded",
    v: "2016"
  }, {
    k: "Films released",
    v: "48"
  }, {
    k: "Awards",
    v: "12"
  }].map(stat => /*#__PURE__*/React.createElement(Card, {
    key: stat.k,
    padding: "lg"
  }, /*#__PURE__*/React.createElement("div", {
    className: "q-eyebrow",
    style: {
      marginBottom: "12px"
    }
  }, stat.k), /*#__PURE__*/React.createElement("div", {
    style: {
      font: "var(--type-display)",
      fontSize: "var(--text-4xl)",
      lineHeight: 1
    }
  }, stat.v)))));
}
window.QPStudio = Studio;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Studio.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.Logo = __ds_scope.Logo;

__ds_ns.SectionHeader = __ds_scope.SectionHeader;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Switch = __ds_scope.Switch;

})();
