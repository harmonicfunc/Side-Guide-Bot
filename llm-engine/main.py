import os
from langchain_anthropic import ChatAnthropic
from langchain_sambanova import ChatSambaNovaCloud
from typing import List, Optional, TypedDict, Annotated, Sequence
from langchain_core.messages import BaseMessage, AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.graph import StateGraph, START, END
from langchain_chroma import chroma

from dotenv import load_dotenv

#loading environment variables
load_dotenv()  # Loads from .env file into os.environ

api_key = os.getenv("SAMBANOVA_API_KEY")

llm = ChatSambaNovaCloud(
    model="DeepSeek-R1-Distill-Llama-70B",
    temperature=0.1,
)

###### Example way of invoking the llm ###################

# response = llm.invoke("Do you have reasoning capabilities? Be more elaborate")
# print(response.content)

#####################################

#####Code snippet to visulaize the langgraph structure#################

# from IPython.display import Image, display

# try:
#     display(Image(graph.get_graph().draw_mermaid_png()))
# except Exception:
#     # This requires some extra dependencies and is optional
#     pass

################################################

# class AgentState(TypedDict):
#     """Agent state, which includes the current state of the graph and the current node."""

#     'message': Annotated[Sequence[BaseMessage], ]


