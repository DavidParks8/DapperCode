import Darwin
import Foundation
import os

enum NativeMemory {
  static func snapshot() throws -> [String: Any] {
    #if targetEnvironment(simulator)
      return [
        "physicalBytes": Double(ProcessInfo.processInfo.physicalMemory),
        "availableBytes": Double(try simulatorHeadroom()),
        "isSimulator": true,
      ]
    #else
      return [
        "physicalBytes": Double(ProcessInfo.processInfo.physicalMemory),
        "availableBytes": Double(os_proc_available_memory()),
        "isSimulator": false,
      ]
    #endif
  }

  #if targetEnvironment(simulator)
    // Simulator processes do not have iOS Jetsam budgets; report advisory host headroom explicitly.
    private static func simulatorHeadroom() throws -> UInt64 {
      let host = mach_host_self()
      defer { _ = mach_port_deallocate(mach_task_self_, host) }
      var pageSize: vm_size_t = 0
      let pageStatus = host_page_size(host, &pageSize)
      guard pageStatus == KERN_SUCCESS else {
        throw NativeMemoryError("Simulator page-size query failed (\(pageStatus)).")
      }
      var statistics = vm_statistics64_data_t()
      var count = mach_msg_type_number_t(
        MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
      let capacity = Int(count)
      let status = withUnsafeMutablePointer(to: &statistics) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: capacity) { data in
          host_statistics64(host, HOST_VM_INFO64, data, &count)
        }
      }
      guard status == KERN_SUCCESS else {
        throw NativeMemoryError("Simulator memory query failed (\(status)).")
      }
      return (UInt64(statistics.free_count) + UInt64(statistics.inactive_count)) * UInt64(pageSize)
    }

    private struct NativeMemoryError: LocalizedError {
      let errorDescription: String?
      init(_ message: String) { errorDescription = message }
    }
  #endif
}
