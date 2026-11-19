#![no_std]
#![no_main]

use core::panic::PanicInfo;

#[link(wasm_import_module = "blinkhost_system")]
unsafe extern "C" {
    fn write_response(bytes: *const u8, len: usize) -> i32;
}

#[unsafe(no_mangle)]
pub extern "C" fn _start() {
    let response = br#"{"status":200,"headers":{"content-type":"text/plain"},"body":"Hello from BlinkHost!"}"#;
    // The host returns the number of response bytes it accepted.
    let written = unsafe { write_response(response.as_ptr(), response.len()) };
    if written != response.len() as i32 {
        core::arch::wasm32::unreachable();
    }
}

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
