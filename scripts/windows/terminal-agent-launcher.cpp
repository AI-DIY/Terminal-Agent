#include <windows.h>
#include <shellapi.h>

#include <string>
#include <vector>

namespace {

std::wstring QuoteWindowsArgument(const std::wstring& value) {
  if (value.empty()) return L"\"\"";
  if (value.find_first_of(L" \t\n\v\"") == std::wstring::npos) return value;

  std::wstring quoted = L"\"";
  size_t backslashes = 0;
  for (wchar_t character : value) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'\"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(character);
      backslashes = 0;
      continue;
    }
    quoted.append(backslashes, L'\\');
    backslashes = 0;
    quoted.push_back(character);
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'\"');
  return quoted;
}

std::wstring ModuleDirectory() {
  std::wstring current(MAX_PATH, L'\0');
  const DWORD length = GetModuleFileNameW(nullptr, current.data(), static_cast<DWORD>(current.size()));
  if (length == 0 || length >= current.size()) return L"";
  current.resize(length);
  const size_t separator = current.find_last_of(L"\\/");
  if (separator == std::wstring::npos) return L"";
  return current.substr(0, separator);
}

bool IsFile(const std::wstring& path) {
  const DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

std::wstring RuntimeInDirectory(const std::wstring& directory) {
  if (directory.empty()) return L"";
  const std::wstring runtime = directory + L"\\Terminal-Agent-runtime.exe";
  return IsFile(runtime) ? runtime : L"";
}

std::wstring InstalledRuntimePath() {
  HKEY key = nullptr;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Terminal-Agent", 0, KEY_QUERY_VALUE, &key) != ERROR_SUCCESS) {
    return L"";
  }

  DWORD type = 0;
  DWORD byteCount = 0;
  const LONG sizeResult = RegQueryValueExW(key, L"InstallPath", nullptr, &type, nullptr, &byteCount);
  if (sizeResult != ERROR_SUCCESS || (type != REG_SZ && type != REG_EXPAND_SZ) || byteCount == 0) {
    RegCloseKey(key);
    return L"";
  }

  std::vector<wchar_t> installPath(byteCount / sizeof(wchar_t) + 1, L'\0');
  const LONG valueResult = RegQueryValueExW(
    key, L"InstallPath", nullptr, &type, reinterpret_cast<LPBYTE>(installPath.data()), &byteCount);
  RegCloseKey(key);
  if (valueResult != ERROR_SUCCESS || installPath.front() == L'\0') return L"";

  std::wstring directory(installPath.data());
  if (type == REG_EXPAND_SZ) {
    const DWORD expandedSize = ExpandEnvironmentStringsW(directory.c_str(), nullptr, 0);
    if (expandedSize == 0) return L"";
    std::vector<wchar_t> expanded(expandedSize, L'\0');
    if (ExpandEnvironmentStringsW(directory.c_str(), expanded.data(), expandedSize) == 0) return L"";
    directory.assign(expanded.data());
  }
  return RuntimeInDirectory(directory);
}

std::wstring RuntimePath() {
  const std::wstring installedRuntime = InstalledRuntimePath();
  if (!installedRuntime.empty()) return installedRuntime;
  return RuntimeInDirectory(ModuleDirectory());
}

void ShowRuntimeNotFoundMessage() {
  MessageBoxW(
    nullptr,
    L"找不到已安装的 Terminal-Agent。\n\n请先安装或启动一次 Terminal-Agent，然后重新从 Assess Client 打开连接。",
    L"Terminal-Agent",
    MB_OK | MB_ICONERROR);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  const std::wstring runtime = RuntimePath();
  if (runtime.empty()) {
    ShowRuntimeNotFoundMessage();
    return 1;
  }

  int argumentCount = 0;
  LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
  if (!arguments) return 1;

  std::wstring commandLine = QuoteWindowsArgument(runtime) + L" --";
  for (int index = 1; index < argumentCount; ++index) {
    commandLine += L" " + QuoteWindowsArgument(arguments[index]);
  }
  LocalFree(arguments);

  STARTUPINFOW startupInfo{};
  startupInfo.cb = sizeof(startupInfo);
  PROCESS_INFORMATION processInformation{};
  std::wstring mutableCommandLine = commandLine;
  const BOOL started = CreateProcessW(
    runtime.c_str(), mutableCommandLine.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr,
    &startupInfo, &processInformation);
  if (!started) return 1;

  CloseHandle(processInformation.hThread);
  CloseHandle(processInformation.hProcess);
  return 0;
}
