import UIKit

@main
final class ATSTestApp: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = UIViewController()
    window.makeKeyAndVisible()
    self.window = window
    Task {
      var result: [String: Any]
      do {
        let image = try Data(contentsOf: Bundle.main.url(forResource: "image", withExtension: "png")!)
        guard UIImage(data: image) != nil else { fatalError("Invalid image fixture") }
        let boundary = "DapperCodeATSImageBoundary"
        var body = Data()
        for (key, value) in [("kind", "image"), ("fileName", "image.png"), ("mimeType", "image/png")] {
          body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(key)\"\r\n\r\n\(value)\r\n".utf8))
        }
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"image.png\"\r\nContent-Type: image/png\r\n\r\n".utf8))
        body.append(image)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var request = URLRequest(url: URL(string: CommandLine.arguments[1])!)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        // Expo fetch also uses URLSessionConfiguration.default and a data task.
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 20
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        result = ["status": (response as! HTTPURLResponse).statusCode, "body": String(decoding: data, as: UTF8.self)]
      } catch {
        let error = error as NSError
        result = ["status": 0, "domain": error.domain, "code": error.code]
      }
      let json = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
      print("ATS_RESULT \(String(decoding: json, as: UTF8.self))")
      exit(0)
    }
    return true
  }
}
