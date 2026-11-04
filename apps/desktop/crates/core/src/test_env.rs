use std::{cell::RefCell, collections::HashMap, ffi::OsString};

thread_local! {
    static OVERRIDES: RefCell<HashMap<String, Option<OsString>>> = RefCell::new(HashMap::new());
}

pub(crate) fn var_os(name: &str) -> Option<OsString> {
    match OVERRIDES.with(|vars| vars.borrow().get(name).cloned()) {
        Some(value) => value,
        None => std::env::var_os(name),
    }
}

pub(crate) fn var(name: &str) -> Result<String, std::env::VarError> {
    var_os(name)
        .ok_or(std::env::VarError::NotPresent)?
        .into_string()
        .map_err(std::env::VarError::NotUnicode)
}

pub(crate) struct Guard {
    name: String,
    previous: Option<Option<OsString>>,
}

pub(crate) fn set(name: &str, value: impl AsRef<std::ffi::OsStr>) -> Guard {
    replace(name, Some(value.as_ref().to_os_string()))
}

pub(crate) fn unset(name: &str) -> Guard {
    replace(name, None)
}

fn replace(name: &str, value: Option<OsString>) -> Guard {
    let previous = OVERRIDES.with(|vars| vars.borrow_mut().insert(name.to_string(), value));
    Guard {
        name: name.to_string(),
        previous,
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        OVERRIDES.with(|vars| match self.previous.take() {
            Some(value) => {
                vars.borrow_mut().insert(self.name.clone(), value);
            }
            None => {
                vars.borrow_mut().remove(&self.name);
            }
        });
    }
}

#[test]
fn overrides_are_scoped_to_the_current_thread_and_restore_nested_values() {
    let name = "DAPPERCODE_TEST_THREAD_LOCAL_ENV";
    let original = std::env::var_os(name);
    let outer = set(name, "outer");
    assert_eq!(var(name).as_deref(), Ok("outer"));
    assert_eq!(std::env::var_os(name), original);
    {
        let _inner = set(name, "inner");
        assert_eq!(var(name).as_deref(), Ok("inner"));
        let observed = std::thread::spawn(move || var_os(name))
            .join()
            .expect("environment observer thread");
        assert_eq!(observed, original);
    }
    assert_eq!(var(name).as_deref(), Ok("outer"));
    drop(outer);
    assert_eq!(var_os(name), original);
}
