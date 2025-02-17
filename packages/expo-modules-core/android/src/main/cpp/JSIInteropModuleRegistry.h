// Copyright © 2021-present 650 Industries, Inc. (aka Expo)

#pragma once

#include "JavaScriptRuntime.h"
#include "JavaScriptModuleObject.h"
#include "JavaScriptValue.h"
#include "JavaScriptObject.h"
#include "JavaReferencesCache.h"
#include "JSReferencesCache.h"
#include "JNIDeallocator.h"

#include <fbjni/fbjni.h>
#include <jsi/jsi.h>
#include <ReactCommon/CallInvokerHolder.h>
#include <ReactCommon/CallInvoker.h>

#if REACT_NATIVE_TARGET_VERSION >= 73

#include <ReactCommon/NativeMethodCallInvokerHolder.h>

#endif

#include <memory>

namespace jni = facebook::jni;
namespace jsi = facebook::jsi;
namespace react = facebook::react;

namespace expo {

/**
 * A JNI wrapper to initialize CPP part of modules and access all data from the module registry.
 */
class JSIInteropModuleRegistry : public jni::HybridClass<JSIInteropModuleRegistry> {
public:
  static auto constexpr
    kJavaDescriptor = "Lexpo/modules/kotlin/jni/JSIInteropModuleRegistry;";
  static auto constexpr TAG = "JSIInteropModuleRegistry";

  static jni::local_ref<jhybriddata> initHybrid(jni::alias_ref<jhybridobject> jThis);

  static void registerNatives();

  /**
   * Initializes the `ExpoModulesHostObject` and adds it to the global object.
   */
  void installJSI(
    jlong jsRuntimePointer,
    jni::alias_ref<JNIDeallocator::javaobject> jniDeallocator,
    jni::alias_ref<react::CallInvokerHolder::javaobject> jsInvokerHolder
  );

  /**
   * Initializes the test runtime. Shouldn't be used in the production.
   */
  void installJSIForTests(
    jni::alias_ref<JNIDeallocator::javaobject> jniDeallocator
  );

  /**
   * Gets a module for a given name. It will throw an exception if the module doesn't exist.
   *
   * @param moduleName
   * @return An instance of `JavaScriptModuleObject`
   */
  jni::local_ref<JavaScriptModuleObject::javaobject> getModule(const std::string &moduleName) const;

  bool hasModule(const std::string &moduleName) const;

  /**
   * Gets names of all available modules.
   */
  jni::local_ref<jni::JArrayClass<jni::JString>> getModulesName() const;

  /**
   * Exposes a `JavaScriptRuntime::evaluateScript` function to Kotlin
   */
  jni::local_ref<JavaScriptValue::javaobject> evaluateScript(jni::JString script);

  /**
   * Exposes a `JavaScriptRuntime::global` function to Kotlin
   */
  jni::local_ref<JavaScriptObject::javaobject> global();

  /**
   * Exposes a `JavaScriptRuntime::createObject` function to Kotlin
   */
  jni::local_ref<JavaScriptObject::javaobject> createObject();

  /**
  * Gets a core module.
  */
  jni::local_ref<JavaScriptModuleObject::javaobject> getCoreModule() const;

  /**
   * Adds a shared object to the internal registry
   * @param native part of the shared object
   * @param js part of the shared object
   */
  void registerSharedObject(
    jni::local_ref<jobject> native,
    jni::local_ref<JavaScriptObject::javaobject> js
  );

  void deleteSharedObject(
    int objectId
  );

  /**
   * Exposes a `JavaScriptRuntime::drainJSEventLoop` function to Kotlin
   */
  void drainJSEventLoop();

  std::shared_ptr<react::CallInvoker> jsInvoker;
  std::shared_ptr<JavaScriptRuntime> runtimeHolder;
  std::unique_ptr<JSReferencesCache> jsRegistry;
  jni::global_ref<JNIDeallocator::javaobject> jniDeallocator;

  bool wasDeallocated = false;

  void registerClass(jni::local_ref<jclass> native,
                     jni::local_ref<JavaScriptObject::javaobject> jsClass);

  jni::local_ref<JavaScriptObject::javaobject> getJavascriptClass(jni::local_ref<jclass> native);

  ~JSIInteropModuleRegistry();

private:
  friend HybridBase;
  jni::global_ref<JSIInteropModuleRegistry::javaobject> javaPart_;

  explicit JSIInteropModuleRegistry(jni::alias_ref<jhybridobject> jThis);

  inline jni::local_ref<JavaScriptModuleObject::javaobject>
  callGetJavaScriptModuleObjectMethod(const std::string &moduleName) const;

  inline jni::local_ref<jni::JArrayClass<jni::JString>> callGetJavaScriptModulesNames() const;

  inline jni::local_ref<JavaScriptModuleObject::javaobject> callGetCoreModuleObject() const;

  inline bool callHasModule(const std::string &moduleName) const;

  void jniWasDeallocated();

  void prepareRuntime();

  void jniSetNativeStateForSharedObject(int id, jni::alias_ref<JavaScriptObject::javaobject> jsObject);
};
} // namespace expo
