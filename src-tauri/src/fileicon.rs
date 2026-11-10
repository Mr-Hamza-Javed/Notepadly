//! Keeps the icon of files Notepadly opens the same as Windows Notepad's.
//!
//! The installer registers the `Notepadly.File` type with Windows' plain text-document
//! icon. Windows 11 Notepad draws text files with its own icon instead, so when
//! Notepadly becomes a type's default app the files would look different. This copies
//! the *reference* to Notepad's icon (the registry string, not the image) onto
//! `Notepadly.File`, so files keep exactly the look Notepad gives them.
//!
//! Notepad's icon string names its package version, which changes when the Store
//! updates Notepad, so this runs on every start. It reads a handful of registry
//! values and writes only when something changed.

#[cfg(windows)]
mod imp {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumValueW, RegGetValueW, RegOpenKeyExW, RegSetKeyValueW, HKEY,
        HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, KEY_READ, REG_SZ, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ,
        RRF_RT_REG_SZ,
    };
    use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};

    const OUR_ICON_KEYS: [&str; 2] = [
        r"Software\Classes\Notepadly.File\DefaultIcon",
        r"Software\Classes\Applications\notepadly.exe\DefaultIcon",
    ];

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Default (or named) string value of `root\path`, without expanding `%vars%`.
    fn read_str(root: HKEY, path: &str, name: Option<&str>) -> Option<String> {
        let path = wide(path);
        let name = name.map(wide);
        let name_ptr = name.as_ref().map_or(std::ptr::null(), |n| n.as_ptr());
        let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
        let mut buf = vec![0u16; 1024];
        let mut bytes = (buf.len() * 2) as u32;
        // SAFETY: buffers are valid for the sizes passed and NUL-terminated where required.
        let status = unsafe {
            RegGetValueW(
                root,
                path.as_ptr(),
                name_ptr,
                flags,
                null_mut(),
                buf.as_mut_ptr().cast(),
                &mut bytes,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let len = (bytes as usize / 2).saturating_sub(1);
        Some(String::from_utf16_lossy(&buf[..len.min(buf.len())]))
    }

    /// Value names under `HKCR\.txt\OpenWithProgids`: every app registered for .txt.
    fn txt_progids() -> Vec<String> {
        let mut key: HKEY = null_mut();
        let path = wide(r".txt\OpenWithProgids");
        // SAFETY: `key` receives an open handle that is closed below.
        if unsafe { RegOpenKeyExW(HKEY_CLASSES_ROOT, path.as_ptr(), 0, KEY_READ, &mut key) }
            != ERROR_SUCCESS
        {
            return Vec::new();
        }
        let mut names = Vec::new();
        for index in 0.. {
            let mut buf = [0u16; 256];
            let mut len = buf.len() as u32;
            // SAFETY: `buf` holds `len` characters; the other out-pointers are optional.
            let status = unsafe {
                RegEnumValueW(
                    key,
                    index,
                    buf.as_mut_ptr(),
                    &mut len,
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                )
            };
            if status != ERROR_SUCCESS {
                break;
            }
            names.push(String::from_utf16_lossy(&buf[..len as usize]));
        }
        // SAFETY: `key` was opened above.
        unsafe { RegCloseKey(key) };
        names
    }

    /// The icon Windows 11 Notepad gives .txt files on this PC, if Notepad is installed.
    fn notepad_txt_icon() -> Option<String> {
        txt_progids().into_iter().find_map(|progid| {
            let app = read_str(
                HKEY_CLASSES_ROOT,
                &format!(r"{progid}\Application"),
                Some("AppUserModelID"),
            )?;
            if !app.starts_with("Microsoft.WindowsNotepad_") {
                return None;
            }
            read_str(HKEY_CLASSES_ROOT, &format!(r"{progid}\DefaultIcon"), None)
        })
    }

    pub fn sync() {
        // Only an installed copy has these keys; a portable one leaves the registry alone.
        let Some(current) = read_str(HKEY_CURRENT_USER, OUR_ICON_KEYS[0], None) else {
            return;
        };
        let Some(icon) = notepad_txt_icon() else {
            return;
        };
        if icon == current {
            return;
        }
        let value = wide(&icon);
        for path in OUR_ICON_KEYS {
            let path = wide(path);
            // SAFETY: strings are NUL-terminated; the size is in bytes and includes the NUL.
            unsafe {
                RegSetKeyValueW(
                    HKEY_CURRENT_USER,
                    path.as_ptr(),
                    std::ptr::null(),
                    REG_SZ,
                    value.as_ptr().cast(),
                    (value.len() * 2) as u32,
                );
            }
        }
        // SAFETY: plain notification with no item pointers.
        unsafe {
            SHChangeNotify(
                SHCNE_ASSOCCHANGED as i32,
                SHCNF_IDLIST,
                std::ptr::null(),
                std::ptr::null(),
            )
        };
    }
}

/// Points Notepadly's file type at Notepad's file icon. Cheap; call off the UI thread.
pub fn sync() {
    #[cfg(windows)]
    imp::sync();
}
