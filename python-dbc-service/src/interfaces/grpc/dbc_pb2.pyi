from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ParseFrameRequest(_message.Message):
    __slots__ = ("frame_data", "timestamp")
    FRAME_DATA_FIELD_NUMBER: _ClassVar[int]
    TIMESTAMP_FIELD_NUMBER: _ClassVar[int]
    frame_data: str
    timestamp: str
    def __init__(self, frame_data: _Optional[str] = ..., timestamp: _Optional[str] = ...) -> None: ...

class ParseFrameResponse(_message.Message):
    __slots__ = ("device_address", "message_id", "message_name", "signals_json", "raw_payload", "crc_valid", "parsed", "error", "timestamp")
    DEVICE_ADDRESS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_NAME_FIELD_NUMBER: _ClassVar[int]
    SIGNALS_JSON_FIELD_NUMBER: _ClassVar[int]
    RAW_PAYLOAD_FIELD_NUMBER: _ClassVar[int]
    CRC_VALID_FIELD_NUMBER: _ClassVar[int]
    PARSED_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    TIMESTAMP_FIELD_NUMBER: _ClassVar[int]
    device_address: int
    message_id: int
    message_name: str
    signals_json: str
    raw_payload: str
    crc_valid: bool
    parsed: bool
    error: str
    timestamp: str
    def __init__(self, device_address: _Optional[int] = ..., message_id: _Optional[int] = ..., message_name: _Optional[str] = ..., signals_json: _Optional[str] = ..., raw_payload: _Optional[str] = ..., crc_valid: bool = ..., parsed: bool = ..., error: _Optional[str] = ..., timestamp: _Optional[str] = ...) -> None: ...

class ParseBatchRequest(_message.Message):
    __slots__ = ("frames",)
    FRAMES_FIELD_NUMBER: _ClassVar[int]
    frames: _containers.RepeatedCompositeFieldContainer[ParseFrameRequest]
    def __init__(self, frames: _Optional[_Iterable[_Union[ParseFrameRequest, _Mapping]]] = ...) -> None: ...
