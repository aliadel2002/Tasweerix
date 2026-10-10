// Loading plugin binaries: shared libraries on Linux and Windows, bundles on macOS.
#pragma once
#include <stdexcept>
#include <string>

#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif
#include <filesystem>

namespace host {

class Library {
 public:
  explicit Library(const std::string &file) {
#ifdef _WIN32
    h = LoadLibraryW(std::filesystem::path(file).wstring().c_str());
    if (!h) throw std::runtime_error("cannot load " + file + " (error " + std::to_string(GetLastError()) + ")");
#else
    h = dlopen(file.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!h) throw std::runtime_error(std::string("cannot load ") + file + ": " + dlerror());
#endif
  }
  ~Library() {
#ifdef _WIN32
    if (h) FreeLibrary(h);
#else
    if (h) dlclose(h);
#endif
  }
  Library(const Library &) = delete;
  Library &operator=(const Library &) = delete;

  void *symbol(const char *name) const {
#ifdef _WIN32
    return reinterpret_cast<void *>(GetProcAddress(h, name));
#else
    return dlsym(h, name);
#endif
  }

 private:
#ifdef _WIN32
  HMODULE h = nullptr;
#else
  void *h = nullptr;
#endif
};

/**
 * The binary inside a plugin: the path itself for a file, `Contents/MacOS/<name>` for a macOS bundle,
 * `Contents/<arch>-linux/<name>.so` or `Contents/<arch>-win/<name>.vst3` for a VST3 bundle folder.
 */
inline std::string pluginBinary(const std::string &path) {
  namespace fs = std::filesystem;
  fs::path p(path);
  if (!fs::is_directory(p)) return path;
  std::string stem = p.stem().string();
  fs::path contents = p / "Contents";
#if defined(__APPLE__)
  fs::path mac = contents / "MacOS" / stem;
  if (fs::exists(mac)) return mac.string();
#endif
#if defined(__x86_64__) || defined(_M_X64)
  const char *arch = "x86_64";
#elif defined(__aarch64__) || defined(_M_ARM64)
  const char *arch = "aarch64";
#else
  const char *arch = "i386";
#endif
#if defined(_WIN32)
  fs::path bin = contents / (std::string(arch) + "-win") / (stem + p.extension().string());
#else
  fs::path bin = contents / (std::string(arch) + "-linux") / (stem + ".so");
#endif
  if (fs::exists(bin)) return bin.string();
  throw std::runtime_error("no binary for this platform inside " + path);
}

}  // namespace host
