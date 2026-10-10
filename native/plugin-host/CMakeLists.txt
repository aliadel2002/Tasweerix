cmake_minimum_required(VERSION 3.25)
project(tasweerix_plugin_host VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

option(TASWEERIX_HOST_VST3 "Host VST3 plugins (downloads the MIT-licensed VST3 SDK)" ON)
option(TASWEERIX_HOST_TESTS "Build the test plugins used by the Tasweerix test suite" ON)

include(FetchContent)
# CLAP is header-only and MIT licensed.
FetchContent_Declare(clap GIT_REPOSITORY https://github.com/free-audio/clap.git GIT_TAG 1.2.2 GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(clap)

add_executable(tasweerix-plugin-host src/main.cpp src/clap_host.cpp)
target_link_libraries(tasweerix-plugin-host PRIVATE clap ${CMAKE_DL_LIBS})

if(TASWEERIX_HOST_VST3)
  # VST3 SDK 3.8 is MIT licensed. Only the submodules hosting needs are fetched; no GUI, no examples.
  FetchContent_Declare(vst3sdk
    GIT_REPOSITORY https://github.com/steinbergmedia/vst3sdk.git
    GIT_TAG v3.8.0_build_66
    GIT_SHALLOW TRUE
    GIT_SUBMODULES base cmake pluginterfaces public.sdk)
  FetchContent_GetProperties(vst3sdk)
  if(NOT vst3sdk_POPULATED)
    FetchContent_Populate(vst3sdk)
  endif()
  set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(SMTG_ENABLE_VSTGUI_SUPPORT OFF CACHE BOOL "" FORCE)
  set(SMTG_CREATE_PLUGIN_LINK OFF CACHE BOOL "" FORCE)
  set(SMTG_RUN_VST_VALIDATOR OFF CACHE BOOL "" FORCE)
  set(SMTG_CREATE_MODULE_INFO OFF CACHE BOOL "" FORCE)
  set(SMTG_ENABLE_AUV2_BUILDS OFF CACHE BOOL "" FORCE)
  add_subdirectory(${vst3sdk_SOURCE_DIR} ${vst3sdk_BINARY_DIR} EXCLUDE_FROM_ALL)

  set(VST3_MODULE_SRC ${vst3sdk_SOURCE_DIR}/public.sdk/source/vst/hosting/module_linux.cpp)
  if(APPLE)
    set(VST3_MODULE_SRC ${vst3sdk_SOURCE_DIR}/public.sdk/source/vst/hosting/module_mac.mm)
    set_source_files_properties(${VST3_MODULE_SRC} PROPERTIES COMPILE_FLAGS "-fobjc-arc")
    enable_language(OBJCXX)
  elseif(WIN32)
    set(VST3_MODULE_SRC ${vst3sdk_SOURCE_DIR}/public.sdk/source/vst/hosting/module_win32.cpp)
  endif()
  target_sources(tasweerix-plugin-host PRIVATE
    src/vst3_host.cpp
    ${VST3_MODULE_SRC}
    ${vst3sdk_SOURCE_DIR}/public.sdk/source/vst/hosting/plugprovider.cpp
    ${vst3sdk_SOURCE_DIR}/public.sdk/source/common/memorystream.cpp)
  target_link_libraries(tasweerix-plugin-host PRIVATE sdk_hosting sdk)
  target_compile_definitions(tasweerix-plugin-host PRIVATE TASWEERIX_HOST_VST3)
  if(APPLE)
    target_link_libraries(tasweerix-plugin-host PRIVATE "-framework CoreFoundation" "-framework Foundation")
  endif()
endif()

if(TASWEERIX_HOST_TESTS)
  add_library(clap-gain MODULE test/clap_gain.c)
  target_link_libraries(clap-gain PRIVATE clap)
  set_target_properties(clap-gain PROPERTIES PREFIX "" SUFFIX ".clap" OUTPUT_NAME "test-gain" C_VISIBILITY_PRESET hidden)
  if(NOT MSVC)
    target_link_libraries(clap-gain PRIVATE m)
  endif()
  if(TASWEERIX_HOST_VST3)
    set(public_sdk_SOURCE_DIR ${vst3sdk_SOURCE_DIR}/public.sdk)  # lets the SDK add the platform entry point
    smtg_add_vst3plugin(vst3-test-gain test/vst3_gain.cpp)
    target_link_libraries(vst3-test-gain PRIVATE sdk)
    add_dependencies(tasweerix-plugin-host vst3-test-gain)
  endif()
endif()
