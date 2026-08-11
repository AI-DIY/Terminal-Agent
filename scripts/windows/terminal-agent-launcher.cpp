#include <windows.h>
#include <shellapi.h>

#include <cwctype>
#include <string>
#include <utility>
#include <vector>

namespace {

struct RuntimeCandidate {
  std::wstring source;
  std::wstring path;
};

using LogFields = std::vector<std::pair<std::wstring, std::wstring>>;

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

std::wstring ModulePath() {
  std::wstring current(MAX_PATH, L'\0');
  const DWORD length = GetModuleFileNameW(nullptr, current.data(), static_cast<DWORD>(current.size()));
  if (length == 0 || length >= current.size()) return L"";
  current.resize(length);
  return current;
}

std::wstring DirectoryName(const std::wstring& path) {
  const size_t separator = path.find_last_of(L"\\/");
  return separator == std::wstring::npos ? L"" : path.substr(0, separator);
}

std::wstring ModuleDirectory() {
  return DirectoryName(ModulePath());
}

std::wstring CurrentDirectory() {
  const DWORD size = GetCurrentDirectoryW(0, nullptr);
  if (size == 0) return L"";
  std::vector<wchar_t> value(size, L'\0');
  if (GetCurrentDirectoryW(size, value.data()) == 0) return L"";
  return value.data();
}

std::wstring JoinPath(const std::wstring& directory, const std::wstring& leaf) {
  if (directory.empty()) return L"";
  if (directory.back() == L'\\' || directory.back() == L'/') return directory + leaf;
  return directory + L"\\" + leaf;
}

bool IsFile(const std::wstring& path) {
  const DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

std::wstring RuntimeInDirectory(const std::wstring& directory) {
  const std::wstring runtime = JoinPath(directory, L"Terminal-Agent-runtime.exe");
  return IsFile(runtime) ? runtime : L"";
}

std::wstring EnvironmentDirectory(const wchar_t* name) {
  const DWORD size = GetEnvironmentVariableW(name, nullptr, 0);
  if (size == 0) return L"";
  std::vector<wchar_t> value(size, L'\0');
  if (GetEnvironmentVariableW(name, value.data(), size) == 0) return L"";
  return value.data();
}

std::wstring InstalledRuntimeDirectory() {
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
  return directory;
}

std::vector<RuntimeCandidate> RuntimeCandidates(const std::wstring& bridgeDirectory) {
  std::vector<RuntimeCandidate> candidates;
  const std::wstring installedDirectory = InstalledRuntimeDirectory();
  if (!installedDirectory.empty()) candidates.push_back({L"registry", JoinPath(installedDirectory, L"Terminal-Agent-runtime.exe")});
  candidates.push_back({L"bridge-directory", JoinPath(bridgeDirectory, L"Terminal-Agent-runtime.exe")});

  const std::wstring localAppData = EnvironmentDirectory(L"LOCALAPPDATA");
  if (!localAppData.empty()) {
    candidates.push_back({L"local-app-data", JoinPath(JoinPath(JoinPath(localAppData, L"Programs"), L"Terminal-Agent"), L"Terminal-Agent-runtime.exe")});
  }
  const std::wstring programFiles = EnvironmentDirectory(L"ProgramFiles");
  if (!programFiles.empty()) candidates.push_back({L"program-files", JoinPath(JoinPath(programFiles, L"Terminal-Agent"), L"Terminal-Agent-runtime.exe")});
  const std::wstring programW6432 = EnvironmentDirectory(L"ProgramW6432");
  if (!programW6432.empty() && programW6432 != programFiles) {
    candidates.push_back({L"program-files-64", JoinPath(JoinPath(programW6432, L"Terminal-Agent"), L"Terminal-Agent-runtime.exe")});
  }
  return candidates;
}

std::wstring JsonEscape(const std::wstring& value) {
  std::wstring escaped;
  for (wchar_t character : value) {
    if (character == L'\\') escaped += L"\\\\";
    else if (character == L'\"') escaped += L"\\\"";
    else if (character == L'\r') escaped += L"\\r";
    else if (character == L'\n') escaped += L"\\n";
    else if (character == L'\t') escaped += L"\\t";
    else if (character < 0x20) {
      wchar_t encoded[7]{};
      swprintf(encoded, 7, L"\\u%04x", static_cast<unsigned int>(character));
      escaped += encoded;
    } else escaped.push_back(character);
  }
  return escaped;
}

std::wstring Timestamp() {
  SYSTEMTIME time{};
  GetSystemTime(&time);
  wchar_t value[32]{};
  swprintf(value, 32, L"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", time.wYear, time.wMonth, time.wDay,
    time.wHour, time.wMinute, time.wSecond, time.wMilliseconds);
  return value;
}

bool AppendUtf8(const std::wstring& path, const std::wstring& line) {
  const int byteCount = WideCharToMultiByte(CP_UTF8, 0, line.data(), static_cast<int>(line.size()), nullptr, 0, nullptr, nullptr);
  if (byteCount <= 0) return false;
  std::vector<char> bytes(byteCount);
  if (WideCharToMultiByte(CP_UTF8, 0, line.data(), static_cast<int>(line.size()), bytes.data(), byteCount, nullptr, nullptr) <= 0) return false;
  HANDLE file = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0;
  const BOOL success = WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr);
  CloseHandle(file);
  return success != FALSE && written == bytes.size();
}

bool CanAppend(const std::wstring& path) {
  HANDLE file = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  CloseHandle(file);
  return true;
}

std::wstring ResolveLogPath(const std::wstring& bridgeDirectory) {
  const std::wstring primary = JoinPath(bridgeDirectory, L"putty-bridge.log");
  if (!primary.empty() && CanAppend(primary)) return primary;

  const std::wstring localAppData = EnvironmentDirectory(L"LOCALAPPDATA");
  if (localAppData.empty()) return primary;
  const std::wstring directory = JoinPath(localAppData, L"Terminal-Agent");
  CreateDirectoryW(directory.c_str(), nullptr);
  const std::wstring fallback = JoinPath(directory, L"putty-bridge.log");
  return CanAppend(fallback) ? fallback : primary;
}

void WriteBridgeLog(const std::wstring& logPath, const std::wstring& launchId, const std::wstring& event, const LogFields& fields = {}) {
  if (logPath.empty()) return;
  std::wstring line = L"{\"timestamp\":\"" + JsonEscape(Timestamp()) + L"\",\"launchId\":\"" + JsonEscape(launchId)
    + L"\",\"source\":\"bridge\",\"event\":\"" + JsonEscape(event) + L"\"";
  for (const auto& field : fields) {
    line += L",\"" + JsonEscape(field.first) + L"\":\"" + JsonEscape(field.second) + L"\"";
  }
  line += L"}\n";
  AppendUtf8(logPath, line);
}

std::wstring Lowercase(const std::wstring& value) {
  std::wstring lowered = value;
  for (wchar_t& character : lowered) character = static_cast<wchar_t>(towlower(character));
  return lowered;
}

bool IsSecretOption(const std::wstring& option) {
  return option == L"-pw" || option == L"-pwfile" || option == L"--password" || option == L"--token"
    || option == L"--api-key" || option == L"--passphrase" || option == L"-passphrase";
}

std::wstring SanitizedArgument(const std::wstring& argument) {
  const std::wstring lowered = Lowercase(argument);
  if (lowered.rfind(L"tmp:", 0) == 0) return L"tmp:[REDACTED]";
  for (const std::wstring option : {L"-pw", L"-pwfile", L"--password", L"--token", L"--api-key", L"--passphrase", L"-passphrase"}) {
    if (lowered.rfind(option + L"=", 0) == 0) return option + L"=[REDACTED]";
  }
  return argument;
}

std::wstring SanitizedArguments(LPWSTR* arguments, int argumentCount) {
  std::wstring output;
  bool redactNext = false;
  for (int index = 1; index < argumentCount; ++index) {
    if (!output.empty()) output += L" | ";
    const std::wstring raw(arguments[index]);
    output += redactNext ? L"[REDACTED]" : SanitizedArgument(raw);
    redactNext = IsSecretOption(Lowercase(raw));
  }
  return output;
}

std::wstring LaunchId() {
  return std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
}

void ShowRuntimeNotFoundMessage(const std::wstring& logPath) {
  std::wstring message = L"找不到可用的 Terminal-Agent 运行时。\n\n请运行新版安装包重新安装 Terminal-Agent，然后重新从 Assess Client 打开连接。";
  if (!logPath.empty()) message += L"\n\n跳转日志：" + logPath;
  MessageBoxW(nullptr, message.c_str(), L"Terminal-Agent", MB_OK | MB_ICONERROR);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  const std::wstring bridgePath = ModulePath();
  const std::wstring bridgeDirectory = DirectoryName(bridgePath);
  const std::wstring launchId = LaunchId();
  const std::wstring logPath = ResolveLogPath(bridgeDirectory);

  int argumentCount = 0;
  LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
  if (!arguments) {
    WriteBridgeLog(logPath, launchId, L"argument-parse-failed", {{L"errorCode", std::to_wstring(GetLastError())}});
    return 1;
  }
  WriteBridgeLog(logPath, launchId, L"bridge-started", {
    {L"bridge", bridgePath},
    {L"workingDirectory", CurrentDirectory()},
    {L"arguments", SanitizedArguments(arguments, argumentCount)},
  });

  std::wstring runtime;
  for (const RuntimeCandidate& candidate : RuntimeCandidates(bridgeDirectory)) {
    const bool exists = IsFile(candidate.path);
    WriteBridgeLog(logPath, launchId, L"runtime-candidate", {
      {L"candidateSource", candidate.source},
      {L"runtime", candidate.path},
      {L"exists", exists ? L"true" : L"false"},
    });
    if (runtime.empty() && exists) runtime = candidate.path;
  }
  if (runtime.empty()) {
    LocalFree(arguments);
    WriteBridgeLog(logPath, launchId, L"runtime-not-found");
    ShowRuntimeNotFoundMessage(logPath);
    return 1;
  }

  std::wstring commandLine = QuoteWindowsArgument(runtime) + L" --"
    + L" --terminal-agent-bridge-log " + QuoteWindowsArgument(logPath)
    + L" --terminal-agent-bridge-id " + QuoteWindowsArgument(launchId);
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
  if (!started) {
    WriteBridgeLog(logPath, launchId, L"bridge-process-start-failed", {{L"runtime", runtime}, {L"errorCode", std::to_wstring(GetLastError())}});
    return 1;
  }

  WriteBridgeLog(logPath, launchId, L"process-started", {{L"runtime", runtime}, {L"processId", std::to_wstring(processInformation.dwProcessId)}});
  CloseHandle(processInformation.hThread);
  CloseHandle(processInformation.hProcess);
  return 0;
}
