//! System font families from the registry. No font parsing, so no font-kit.

use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
use winreg::RegKey;

const FONTS_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts";

/// Trailing words that name a style of a family rather than the family.
/// "Black", "Medium", "Condensed" and "Narrow" are left alone: Windows ships
/// families whose real names end in them (Arial Black, Franklin Gothic Medium).
const STYLE_WORDS: &[&str] = &[
    "bold", "italic", "oblique", "regular", "light", "semilight", "semibold", "demibold", "thin",
    "extralight", "ultralight", "extrabold", "ultrabold", "heavy",
];

pub fn system_fonts() -> Vec<String> {
    let mut names = Vec::new();
    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        if let Ok(key) = RegKey::predef(hive).open_subkey(FONTS_KEY) {
            names.extend(key.enum_values().flatten().map(|(name, _)| name));
        }
    }
    families(names)
}

fn families(value_names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = value_names
        .into_iter()
        .flat_map(|name| parse_value_name(&name))
        .collect();
    out.sort_by_key(|n| n.to_lowercase());
    out.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    out
}

/// One registry value name can list several faces joined by `&`.
fn parse_value_name(name: &str) -> Vec<String> {
    let mut name = name.trim();
    if let Some(open) = name.rfind('(') {
        let kind = name[open..].to_ascii_lowercase();
        if kind != "(truetype)" && kind != "(opentype)" {
            // Bitmap and vector fonts such as "Modern (All res)": unusable in a webview.
            return Vec::new();
        }
        name = name[..open].trim_end();
    }
    name.split('&').filter_map(family_of).collect()
}

fn family_of(face: &str) -> Option<String> {
    let mut words: Vec<&str> = face.split_whitespace().collect();
    while words.len() > 1 {
        let last = words[words.len() - 1].to_ascii_lowercase();
        if !STYLE_WORDS.contains(&last.as_str()) {
            break;
        }
        words.pop();
    }
    let family = words.join(" ");
    (!family.is_empty() && !family.starts_with('@')).then_some(family)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_suffix_and_styles_then_dedupes_and_sorts() {
        let raw = [
            "Segoe UI Semibold Italic (TrueType)",
            "Segoe UI (TrueType)",
            "segoe ui bold (TrueType)",
            "Arial Black (TrueType)",
            "Cambria & Cambria Math (TrueType)",
            "Inter Regular (OpenType)",
            "Modern (All res)",
            "Bold (TrueType)",
        ];
        assert_eq!(
            families(raw.iter().map(|s| s.to_string())),
            ["Arial Black", "Bold", "Cambria", "Cambria Math", "Inter", "Segoe UI"]
        );
    }

    #[test]
    fn reads_real_fonts_from_this_machine() {
        let fonts = system_fonts();
        assert!(fonts.iter().any(|f| f == "Segoe UI"), "{fonts:?}");
        assert!(!fonts.iter().any(|f| f.contains("(TrueType)")));
    }
}
